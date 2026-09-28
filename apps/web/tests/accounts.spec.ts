import type { Card } from '@etymology-feed/shared/card';
import { expect, type Page, test } from '@playwright/test';
import { putCardsOnStack, waitForSavedSwipes } from './helpers/cards';

async function signInWithMockProvider(page: Page) {
  await page.goto('/settings/#account');
  const button = page.getByRole('button', {
    name: 'Continue with Test account',
  });
  await expect(button).toBeVisible();
  const callback = page.waitForResponse((response) =>
    response.url().includes('/auth/callback/mock'),
  );
  await button.click();
  await callback;
  await page.waitForURL('**/liked/', { timeout: 20_000 });
  await page.waitForLoadState('domcontentloaded');
  const me = await page.request.get('/api/me');
  expect(me.ok()).toBe(true);
  expect(
    ((await me.json()) as { user: { isAnonymous: boolean } }).user.isAnonymous,
  ).toBe(false);
}

test('offline guest likes survive sign-in and union with a second device', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const bluffResponse = await page.request.get('/api/words/bluff/etymologies');
  const { cards: bluffs } = (await bluffResponse.json()) as { cards: Card[] };
  await putCardsOnStack(page, bluffs);
  await page.keyboard.press('ArrowRight');
  await waitForSavedSwipes(page, 1);
  await page.context().setOffline(true);
  await expect(page.getByTestId('top-card')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await waitForSavedSwipes(page, 2);
  await page.context().setOffline(false);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: 'bluff' })).toHaveCount(2);
  await signInWithMockProvider(page);
  await expect(page.getByRole('heading', { name: 'bluff' })).toHaveCount(2);

  const second = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const other = await second.newPage();
    await other.goto('/');
    await expect(other.getByTestId('top-card')).toBeVisible();
    const extraResponse = await other.request.get(
      '/api/words/béarnaise%20sauce',
    );
    const extra = (await extraResponse.json()) as Card;
    await putCardsOnStack(other, [extra]);
    await other.keyboard.press('ArrowRight');
    await waitForSavedSwipes(other, 1);
    await other.goto('/liked/');
    await signInWithMockProvider(other);
    await expect(other.getByRole('heading', { name: 'bluff' })).toHaveCount(2);
    await expect(
      other.getByRole('heading', { name: 'béarnaise sauce' }),
    ).toHaveCount(1);

    await other.goto('/settings/#account');
    await other.getByRole('button', { name: 'Sign out' }).click();
    await other.waitForURL((url) => url.pathname === '/');
    await other.goto('/liked/');
    await expect(other.getByRole('heading', { name: 'bluff' })).toHaveCount(0);
    await expect(
      other.getByRole('heading', { name: 'béarnaise sauce' }),
    ).toHaveCount(0);

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'béarnaise sauce' }),
    ).toHaveCount(1);
    const feed = await page.request.get('/api/feed?n=100');
    expect(feed.ok()).toBe(true);
    const { cards } = (await feed.json()) as { cards: Card[] };
    const likedIds = new Set([...bluffs.map(({ id }) => id), extra.id]);
    expect(cards.some(({ id }) => likedIds.has(id))).toBe(false);

    await page.goto('/settings/#account');
    await expect(
      page.getByRole('button', { name: 'Delete account' }),
    ).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete account' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.goto('/liked/');
    await expect(page.getByRole('heading', { name: 'bluff' })).toHaveCount(0);
    const meAfter = await page.request.get('/api/me');
    expect(
      ((await meAfter.json()) as { user: { isAnonymous: boolean } }).user
        .isAnonymous,
    ).toBe(true);
  } finally {
    await second.close();
  }
});
