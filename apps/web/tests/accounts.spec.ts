import type { Card } from '@etymology-feed/shared/card';
import {
  getStackIds,
  putCardsOnStack,
  waitForSavedSwipes,
} from './helpers/cards';
import { expect, type Page, test } from './helpers/test';

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

test('signed-in Settings stays visible across repeat navigation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signInWithMockProvider(page);
  const nav = page.locator('.bottom-nav');

  for (let visit = 0; visit < 3; visit++) {
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/$/);
    await expect(
      page.getByRole('radiogroup', { name: 'Theme', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: 'Color mode' }),
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Include proper nouns' }),
    ).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await nav.getByRole('link', { name: 'Liked' }).click();
    await expect(page).toHaveURL(/\/liked\/$/);
  }
  expect(errors).toEqual([]);
});

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
  // Both origins of one headword must be saved under their own card IDs.
  await waitForSavedSwipes(
    page,
    2,
    bluffs.map(({ id }) => id),
  );
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
    // This device also holds a bluff card, which the account already liked.
    await putCardsOnStack(other, [extra, bluffs[0]]);
    await other.keyboard.press('ArrowRight');
    await waitForSavedSwipes(other, 1);
    await other.goto('/liked/');
    await signInWithMockProvider(other);
    await expect(other.getByRole('heading', { name: 'bluff' })).toHaveCount(2);
    await expect(
      other.getByRole('heading', { name: 'béarnaise sauce' }),
    ).toHaveCount(1);
    // Loading the account's likes takes them out of this device's Feed.
    await expect.poll(() => getStackIds(other)).toEqual([]);

    // Waiting cards leave once another device of the account rates them:
    // checked when the Feed opens, and every 10 swipes while it stays open.
    const batch = await other.request.get('/api/feed?n=100');
    expect(batch.ok()).toBe(true);
    const upcoming = ((await batch.json()) as { cards: Card[] }).cards.slice(
      0,
      14,
    );
    expect(upcoming).toHaveLength(14);
    await putCardsOnStack(other, upcoming);
    const likeOnFirstDevice = async (card: Card) => {
      await putCardsOnStack(page, [card]);
      await page.keyboard.press('ArrowRight');
      await waitForSavedSwipes(page, 1, [card.id]);
      await page.goto('/liked/');
      await expect
        .poll(async () => {
          const response = await page.request.get('/api/me/likes?limit=200');
          const { likes } = (await response.json()) as {
            likes: { cardId: string }[];
          };
          return likes.some(({ cardId }) => cardId === card.id);
        })
        .toBe(true);
    };
    const top = other.getByTestId('top-card').locator('h2');
    await likeOnFirstDevice(upcoming[0]);
    await other.goto('/');
    await expect(top).toHaveText(upcoming[1].word);
    await likeOnFirstDevice(upcoming[12]);
    for (const card of upcoming.slice(1, 11)) {
      await expect(top).toHaveText(card.word);
      await other.keyboard.press('ArrowRight');
    }
    await expect.poll(() => getStackIds(other)).not.toContain(upcoming[12].id);
    await expect(top).toHaveText(upcoming[11].word);
    await other.keyboard.press('ArrowRight');
    await expect(top).toHaveText(upcoming[13].word);

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
