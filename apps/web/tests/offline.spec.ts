import { expect, test } from '@playwright/test';

test('a right swipe adds a word to Liked and survives reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(
    page.locator('.bottom-nav').getByRole('link', { name: 'Settings' }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Number(
        await page
          .getByTestId('deck-controls')
          .getAttribute('data-stack-count'),
      ),
    )
    .toBeGreaterThanOrEqual(150);
  const word = await page.getByTestId('top-card').locator('h2').innerText();
  await expect(page.locator('.card-topline, .ipa')).toHaveCount(0);
  await page.getByRole('button', { name: 'Interesting' }).click();
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(word);
  await expect(page.locator('.undo-toast')).toHaveCount(0);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: word })).toBeVisible();
  await expect(page.getByText('Words you love.')).toHaveCount(0);
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
    .poll(async () =>
      Number(
        await page
          .getByTestId('deck-controls')
          .getAttribute('data-stack-count'),
      ),
    )
    .toBeGreaterThanOrEqual(100);
  expect(feedFetches).toBeGreaterThanOrEqual(1);
  await context.setOffline(true);
  for (let i = 0; i < 100; i++) {
    const before = Number(
      await page.getByTestId('deck-controls').getAttribute('data-stack-count'),
    );
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('deck-controls')).toHaveAttribute(
      'data-stack-count',
      String(before - 1),
    );
  }
  await page.goto('/liked/');
  await expect(page.locator('.liked-item')).toHaveCount(100);
  await expect(page.getByText('100 swipes waiting to sync')).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.liked-item')).toHaveCount(100);
});

test('keyboard controls and undo work without a toast', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const first = await page.getByTestId('top-card').locator('h2').innerText();
  await page.keyboard.press('d');
  await expect(page.getByText('Hide definition')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(
    first,
  );
  await page.keyboard.press('z');
  await expect(page.getByTestId('top-card').locator('h2')).toHaveText(first);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(
    first,
  );
});

test('Settings opens from navigation and the definition choice survives reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await page
    .locator('.bottom-nav')
    .getByRole('link', { name: 'Settings' })
    .click();
  await page.getByLabel('Always show definitions').check();
  await expect(page.getByText('Hide definition')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Hide definition')).toBeVisible();
});

test('the four RWG palettes persist and system mode follows the device', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?settings=1');
  await expect(page.locator('html')).toHaveClass(/pink dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/pink light/);

  await page.getByLabel('Cool palette').check();
  await expect(page.locator('html')).toHaveClass(/blue light/);
  await page.getByLabel('Dark mode').check();
  await expect(page.locator('html')).toHaveClass(/blue dark/);
  await page.reload();
  await expect(page.getByLabel('Cool palette')).toBeChecked();
  await expect(page.getByLabel('Dark mode')).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/blue dark/);

  await page.getByLabel('Cool palette').uncheck();
  await expect(page.locator('html')).toHaveClass(/pink dark/);
  await page.goto('/liked/');
  await expect(page.locator('html')).toHaveClass(/pink dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    '#25141B',
  );
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
  const exitTransition = page.evaluate(() => {
    const top = document.querySelector('[data-testid="top-card"]');
    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 390);
      top?.addEventListener('transitionend', (event) => {
        if ((event as TransitionEvent).propertyName !== 'transform') return;
        clearTimeout(timeout);
        resolve(true);
      });
    });
  });
  await page.mouse.up();
  expect(await exitTransition).toBe(true);
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(
    first,
  );
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: first })).toBeVisible();
});

test('a swipe reveals the next card without bringing the outgoing card back', async ({
  page,
}) => {
  await page.goto('/');
  const top = page.getByTestId('top-card');
  await expect(top).toBeVisible();
  await expect(page.locator('.card-peek h2')).toBeVisible();
  await expect(page.locator('.card-peek .word-head')).toHaveCSS('opacity', '0');
  const nextWord = await page.locator('.card-peek h2').innerText();
  const handoff = page.evaluate(() => {
    const topCard = document.querySelector('[data-testid="top-card"]');
    const firstWord = topCard?.querySelector('h2')?.textContent;
    return new Promise<{ className: string; transform: string }>((resolve) => {
      const observer = new MutationObserver(() => {
        if (topCard?.querySelector('h2')?.textContent === firstWord) return;
        observer.disconnect();
        resolve({
          className: topCard?.className ?? '',
          transform: topCard ? getComputedStyle(topCard).transform : '',
        });
      });
      if (topCard)
        observer.observe(topCard, {
          subtree: true,
          childList: true,
          characterData: true,
        });
    });
  });
  await page.getByRole('button', { name: 'Interesting' }).click();
  const state = await handoff;
  expect(state.className).toContain('settling');
  expect(state.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
  const returnOffset = await page.evaluate(async () => {
    const topCard = document.querySelector('[data-testid="top-card"]');
    if (!topCard) throw new Error('Top card is missing after the swipe.');
    let maximum = 0;
    for (let frame = 0; frame < 12; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const transform = getComputedStyle(topCard).transform;
      maximum = Math.max(
        maximum,
        Math.abs(new DOMMatrixReadOnly(transform).m41),
      );
    }
    return maximum;
  });
  expect(returnOffset).toBeLessThan(1);
  await expect(top.locator('h2')).toHaveText(nextWord);
});
