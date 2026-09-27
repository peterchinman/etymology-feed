import type { Card } from '@etymology-feed/shared/card';
import { expect, test } from '@playwright/test';

test('two origins of one headword stay separate in the offline stack and Liked', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const response = await page.request.get('/api/words/bluff/etymologies');
  expect(response.ok()).toBe(true);
  const { cards } = (await response.json()) as { cards: Card[] };
  expect(cards).toHaveLength(2);
  await page.evaluate(async (pair) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('etymology-feed');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['stack', 'served'], 'readwrite');
      tx.objectStore('stack').put(pair, 'cards');
      tx.objectStore('served').put(
        pair.map((card) => card.id),
        'words',
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, cards);
  await page.reload();
  await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
    cards[0].etymology,
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
    cards[1].etymology,
  );
  await page.keyboard.press('ArrowRight');
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: 'bluff' })).toHaveCount(2);
  expect(
    (await page.locator('.liked-etymology').allTextContents()).sort(),
  ).toEqual(cards.map(({ etymology }) => etymology).sort());
});
