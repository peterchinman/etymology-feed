import type { Card } from '@etymology-feed/shared/card';
import { expect, type Page } from '@playwright/test';

export async function putCardsOnStack(
  page: Page,
  cards: Card[],
  firstVisible = cards[0],
) {
  // Stop the live feed before replacing its database, and intercept worker-owned
  // requests as well as page requests. Otherwise a refill can race this fixture.
  await page
    .context()
    .route('**/api/feed?*', (route) => route.fulfill({ json: { cards: [] } }));
  await page.goto('/settings/');
  await expect(
    page.getByRole('switch', { name: 'Include proper nouns' }),
  ).toBeEnabled();
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
        pair.map(({ id }) => id),
        'words',
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    // Keep the synchronous preview consistent with this IndexedDB fixture.
    localStorage.setItem(
      'etymology-stack-preview',
      JSON.stringify(pair.slice(0, 2)),
    );
  }, cards);
  await page.goto('/');
  await expect(page.getByTestId('top-card').locator('h2')).toHaveText(
    firstVisible.word,
  );
  await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
    firstVisible.etymology,
  );
  await expect(
    page.getByRole('button', { name: 'Interesting', exact: true }),
  ).toBeEnabled();
}

export async function waitForSavedSwipes(
  page: Page,
  count: number,
  cardIds?: string[],
) {
  await page.waitForFunction(
    async ({ count: expected, cardIds }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('etymology-feed');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const swipes = await new Promise<
        { cardId: string; verdict: number; removed?: boolean }[]
      >((resolve, reject) => {
        const request = database
          .transaction('swipes')
          .objectStore('swipes')
          .getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return (
        swipes.length >= expected &&
        (!cardIds ||
          cardIds.every((id) =>
            swipes.some(
              (swipe) =>
                swipe.cardId === id && swipe.verdict === 1 && !swipe.removed,
            ),
          ))
      );
    },
    { count, cardIds },
  );
}

/** Card IDs in the saved Feed stack, in order. */
export async function getStackIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('etymology-feed');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cards = await new Promise<{ id: string }[] | undefined>(
      (resolve, reject) => {
        const request = database
          .transaction('stack')
          .objectStore('stack')
          .get('cards');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    database.close();
    return (cards ?? []).map(({ id }) => id);
  });
}
