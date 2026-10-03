import { expect, test } from '@playwright/test';

test('searches from mobile navigation, saves separate origins offline, and unlikes with the heart', async ({
  page,
  context,
}) => {
  // Other specs like bluff in the same database, so compare against its totals now.
  const before = await page.request.get('/api/words/bluff/etymologies');
  const { cards: initial } = (await before.json()) as {
    cards: { likeCount: number }[];
  };
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search\//);
  await expect(
    page.getByRole('link', { name: 'Search', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const field = page.getByRole('searchbox', { name: 'Search words' });
  await field.fill('BLUF');
  await page.getByRole('button', { name: 'bluff', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'bluff', exact: true }),
  ).toHaveCount(2);
  await expect(page.locator('.search-results .liked-item')).toHaveCount(2);
  await context.setOffline(true);
  const save = page.getByRole('button', {
    name: /Save bluff origin/,
    pressed: false,
  });
  const saved = page.getByRole('button', {
    name: /Save bluff origin/,
    pressed: true,
  });
  await expect(save.first()).toBeEnabled();
  // The heart sits at the lower right, in the source row, outlined until liked.
  const firstCard = page.locator('.search-results .liked-item').first();
  const heart = firstCard.locator('.heart-toggle');
  const source = firstCard.getByRole('link', { name: 'Wiktionary' });
  const [heartBox, sourceBox, cardBox] = await Promise.all([
    heart.boundingBox(),
    source.boundingBox(),
    firstCard.boundingBox(),
  ]);
  if (!heartBox || !sourceBox || !cardBox)
    throw new Error('Search card footer is missing.');
  expect(heartBox.x).toBeGreaterThan(sourceBox.x + sourceBox.width);
  expect(
    Math.abs(
      heartBox.y + heartBox.height / 2 - (sourceBox.y + sourceBox.height / 2),
    ),
  ).toBeLessThan(5);
  expect(
    cardBox.x + cardBox.width - (heartBox.x + heartBox.width),
  ).toBeLessThan(cardBox.width / 10);
  await expect(heart.locator('path')).toHaveAttribute('fill', 'none');
  await save.first().click();
  await expect(saved).toHaveCount(1);
  await expect(heart.locator('path')).toHaveAttribute('fill', 'currentColor');
  await save.first().click();
  await expect(saved).toHaveCount(2);
  const synced = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync') && response.ok(),
  );
  await context.setOffline(false);
  await synced;
  await page.getByRole('link', { name: 'Liked', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'bluff', exact: true }),
  ).toHaveCount(2);
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await field.fill('bluff');
  await field.press('Enter');
  await expect(saved).toHaveCount(2);
  const result = await page.request.get('/api/words/bluff/etymologies');
  const { cards } = await result.json();
  expect(cards.map((card: { likeCount: number }) => card.likeCount)).toEqual(
    initial.map(({ likeCount }) => likeCount + 1),
  );

  // Tapping a filled heart unlikes that origin, here and on the server.
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/api/swipes/') &&
      response.ok(),
  );
  await heart.click();
  await expect(saved).toHaveCount(1);
  await expect(heart.locator('path')).toHaveAttribute('fill', 'none');
  await removed;
  const afterUnlike = await page.request.get('/api/words/bluff/etymologies');
  const { cards: remaining } = await afterUnlike.json();
  expect(
    remaining.map((card: { likeCount: number }) => card.likeCount),
  ).toEqual([initial[0].likeCount, initial[1].likeCount + 1]);
  await page.getByRole('link', { name: 'Liked', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'bluff', exact: true }),
  ).toHaveCount(1);
});

test('supports Enter, accented multiword lookups, empty results, and recovery from network errors', async ({
  page,
}) => {
  await page.goto('/search/');
  const field = page.getByRole('searchbox', { name: 'Search words' });
  await field.fill('be\u0301arnaise sauce');
  await field.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'béarnaise sauce' }),
  ).toBeVisible();
  await field.fill('zzzznotaword');
  await expect(page.getByRole('status')).toContainText('No matching words');
  await page.route('**/api/search?*', (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  );
  await field.fill('bluff');
  await expect(page.getByRole('alert')).toContainText('Could not search');
  await page.unroute('**/api/search?*');
  await field.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'bluff', exact: true }),
  ).toHaveCount(2);
  await field.fill('');
  await expect(page.locator('.search-results article')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Search', exact: true }),
  ).toBeDisabled();
});

test('ignores an old search response and exposes desktop navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/search/');
  await expect(
    page.locator('.top-nav').getByRole('link', { name: 'Search', exact: true }),
  ).toBeVisible();
  const field = page.getByRole('searchbox', { name: 'Search words' });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/search?q=old', async (route) => {
    await waiting;
    await route
      .fulfill({ json: { words: ['old response'], hasMore: false } })
      .catch(() => {});
  });
  const oldRequest = page.waitForRequest('**/api/search?q=old');
  await field.fill('old');
  await oldRequest;
  await field.fill('bluff');
  await expect(
    page.getByRole('button', { name: 'bluff', exact: true }),
  ).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'old response' })).toHaveCount(
    0,
  );
});
