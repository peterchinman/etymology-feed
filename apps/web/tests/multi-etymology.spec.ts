import type { Card } from '@etymology-feed/shared/card';
import { expect, test } from '@playwright/test';
import { putCardsOnStack, waitForSavedSwipes } from './helpers/cards';

test('two origins of one headword stay separate in the offline stack and Liked', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const response = await page.request.get('/api/words/bluff/etymologies');
  expect(response.ok()).toBe(true);
  const { cards } = (await response.json()) as { cards: Card[] };
  expect(cards).toHaveLength(2);
  await putCardsOnStack(page, cards);
  await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
    cards[0].etymology,
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
    cards[1].etymology,
  );
  await page.keyboard.press('ArrowRight');
  await waitForSavedSwipes(page, 2);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: 'bluff' })).toHaveCount(2);
  expect(
    (await page.locator('.liked-etymology').allTextContents()).sort(),
  ).toEqual(cards.map(({ etymology }) => etymology).sort());
});
