import type { Card } from '@etymology-feed/shared/card';
import { expect, test } from '@playwright/test';
import { putCardsOnStack, waitForSavedSwipes } from './helpers/cards';

// This fixture routes feed requests; service-worker fetches bypass page routes.
// The offline suite separately exercises the real service worker.
test.use({ serviceWorkers: 'block' });

for (const legacy of [false, true]) {
  test(`swiping a common origin preserves its hidden proper sibling (${legacy ? 'legacy' : 'explicit'} ID)`, async ({
    page,
  }) => {
    await page.route('**/api/feed?*', (route) =>
      route.fulfill({ json: { cards: [] } }),
    );
    await page.goto('/');
    await page.waitForFunction(async () =>
      (await indexedDB.databases()).some(
        ({ name }) => name === 'etymology-feed',
      ),
    );
    const response = await page.request.get('/api/words/bluff/etymologies');
    const { cards } = (await response.json()) as { cards: Card[] };
    const common = cards.find((card) => card.id === 'bluff');
    const sibling = cards.find((card) => card.id !== 'bluff');
    if (!common || !sibling)
      throw new Error('Expected both Bluff fixture origins.');
    const proper = {
      ...sibling,
      defPos: 'proper noun',
      pos: ['proper noun'],
    };
    await putCardsOnStack(page, [proper, common], common);
    await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
      common.etymology,
    );
    if (legacy) {
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('etymology-feed');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('stack', 'readwrite');
          const store = tx.objectStore('stack');
          const req = store.get('cards');
          req.onsuccess = () => {
            const cards = req.result as Partial<Card>[];
            delete cards[1].id;
            store.put(cards, 'cards');
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
    }
    await page
      .getByRole('button', { name: 'Interesting', exact: true })
      .click();
    await waitForSavedSwipes(page, 1);
    const remaining = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('etymology-feed');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const cards = await new Promise<Card[]>((resolve, reject) => {
        const req = db.transaction('stack').objectStore('stack').get('cards');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return cards.map((card) => card.id);
    });
    expect(remaining).toEqual([proper.id]);
    await page.goto('/liked/');
    await expect(page.locator('.liked-etymology')).toHaveText(common.etymology);
    await page.goto('/settings/');
    const toggle = page.getByRole('switch', { name: 'Include proper nouns' });
    await expect(toggle).toBeEnabled();
    await toggle.check();
    await expect(toggle).toBeEnabled();
    await page.goto('/');
    await expect(page.getByTestId('top-card').locator('.etymology')).toHaveText(
      proper.etymology,
    );
  });
}
