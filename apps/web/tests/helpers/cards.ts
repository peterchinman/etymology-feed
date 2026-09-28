import type { Card } from '@etymology-feed/shared/card';
import { expect, type Page } from '@playwright/test';

export async function putCardsOnStack(
  page: Page,
  cards: Card[],
  firstVisible = cards[0],
) {
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
  await page.reload();
  await expect(page.getByTestId('top-card').locator('h2')).toHaveText(
    firstVisible.word,
  );
  await expect(
    page.getByRole('button', { name: 'Interesting', exact: true }),
  ).toBeEnabled();
}

export async function waitForSavedSwipes(page: Page, count: number) {
  await page.waitForFunction(async (expected) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('etymology-feed');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const total = await new Promise<number>((resolve, reject) => {
      const request = database
        .transaction('swipes')
        .objectStore('swipes')
        .count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return total >= expected;
  }, count);
}
