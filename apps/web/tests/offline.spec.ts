import { expect, type Page, test } from '@playwright/test';
import { THEME_COLORS } from '../src/lib/themes';

test('definitions appear beneath the title and expand beyond the responsive line limit', async ({
  page,
}) => {
  const longDefinition =
    'A word with a detailed definition that continues beyond the preview. '.repeat(
      15,
    );
  await page.context().route('**/api/feed?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.cards.forEach((card: { definition: string }, index: number) => {
      card.definition = index === 1 ? 'A short definition.' : longDefinition;
    });
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  const card = page.getByTestId('top-card');
  const definition = card.locator('.definition p');
  const more = card.getByRole('button', { name: 'See more', exact: true });
  await expect(more).toBeVisible();
  const titleBox = await card.locator('h2').boundingBox();
  const definitionBox = await definition.boundingBox();
  const etymologyBox = await card.locator('.etymology').boundingBox();
  if (!titleBox || !definitionBox || !etymologyBox)
    throw new Error('Card content has no visible bounds.');
  expect(definitionBox.y).toBeGreaterThan(titleBox.y + titleBox.height);
  expect(etymologyBox.y).toBeGreaterThan(
    definitionBox.y + definitionBox.height,
  );
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(more).toBeVisible();
    expect(
      await definition.evaluate(
        (element, lines) =>
          Math.abs(
            element.clientHeight -
              Number.parseFloat(getComputedStyle(element).lineHeight) * lines,
          ),
        width <= 768 ? 3 : 2,
      ),
    ).toBeLessThanOrEqual(1);
    const previewBounds = await definition.boundingBox();
    const toggleBounds = await more.boundingBox();
    if (!previewBounds || !toggleBounds)
      throw new Error('Definition preview has no visible bounds.');
    expect(toggleBounds.y).toBeGreaterThan(previewBounds.y);
    expect(toggleBounds.y + toggleBounds.height).toBeLessThanOrEqual(
      previewBounds.y + previewBounds.height + 1,
    );
    await more.click();
    const less = card.getByRole('button', { name: 'See less', exact: true });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(definition).toHaveText(longDefinition.trim());
    expect(
      await definition.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBeLessThanOrEqual(1);
    await less.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
  }
  await page.getByRole('button', { name: 'Interesting' }).click();
  await expect(definition).toHaveText('A short definition.');
  await expect(card.locator('.definition-toggle')).toHaveCount(0);
  await page.getByRole('button', { name: 'Interesting' }).click();
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
});

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
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('etymology-feed');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const count = database
                .transaction('swipes')
                .objectStore('swipes')
                .count();
              count.onsuccess = () => {
                database.close();
                resolve(count.result);
              };
              count.onerror = () => reject(count.error);
            };
          }),
      ),
    )
    .toBeGreaterThan(0);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: word })).toBeVisible();
  await expect(page.getByText('Words you love.')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: word })).toBeVisible();
});

test('Feed restores the saved top card without a loading message', async ({
  page,
}) => {
  await page.goto('/');
  const top = page.getByTestId('top-card').locator('h2');
  await expect(top).toBeVisible();
  const first = await top.innerText();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const preview = JSON.parse(
          localStorage.getItem('etymology-stack-preview') ?? '[]',
        );
        return preview[0]?.word;
      }),
    )
    .toBe(first);

  await page.reload();
  await expect(top).toHaveText(first);
  await expect(page.getByText('Opening your stack…')).toHaveCount(0);

  await page.getByRole('button', { name: 'Interesting' }).click();
  const next = await top.innerText();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const preview = JSON.parse(
          localStorage.getItem('etymology-stack-preview') ?? '[]',
        );
        return preview[0]?.word;
      }),
    )
    .toBe(next);
  await page.reload();
  await expect(top).toHaveText(next);
});

test('a cached Feed preview cannot be swiped before the saved stack loads', async ({
  page,
}) => {
  await page.goto('/');
  const top = page.getByTestId('top-card').locator('h2');
  const like = page.getByRole('button', { name: 'Interesting', exact: true });
  await expect(like).toBeEnabled();
  const savedWord = await top.innerText();
  await page.addInitScript(() => {
    const preview = JSON.parse(
      localStorage.getItem('etymology-stack-preview') ?? '[]',
    );
    preview[0] = { ...preview[0], id: 'stale-preview', word: 'Stale preview' };
    localStorage.setItem('etymology-stack-preview', JSON.stringify(preview));
    const pending: (() => void)[] = [];
    let released = false;
    const state = window as typeof window & { releaseStackRead: () => void };
    state.releaseStackRead = () => {
      released = true;
      for (const resolve of pending) resolve();
    };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query) {
      const request = get.call(this, query);
      if (this.name === 'stack' && !released) {
        request.addEventListener(
          'success',
          (event) => {
            if (released) return;
            event.stopImmediatePropagation();
            pending.push(() => request.dispatchEvent(new Event('success')));
          },
          { once: true },
        );
      }
      return request;
    };
  });
  await page.reload();
  await expect(top).toHaveText('Stale preview');
  await expect(like).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(top).toHaveText('Stale preview');
  await page.evaluate(() => {
    (
      window as typeof window & { releaseStackRead: () => void }
    ).releaseStackRead();
  });
  await expect(top).toHaveText(savedWord);
  await expect(like).toBeEnabled();
  await expect(
    page.getByText('The swipe could not be saved. Please try again.'),
  ).toHaveCount(0);
  await page.goto('/liked/');
  await expect(page.locator('.liked-item')).toHaveCount(0);
});

test('Feed and Liked navigate without reloading the shared header', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('etymology-theme', 'indigo');
    localStorage.setItem('etymology-color-mode', 'dark');
  });
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & { brand?: Element | null };
    state.brand = document.querySelector('.brand');
  });
  const liked = page.locator('.top-nav').getByRole('link', { name: 'Liked' });
  await liked.click();
  await expect(page).toHaveURL(/\/liked\/$/);
  await expect(liked).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle('Liked · Etymology Feed');
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { brand?: Element | null };
      return state.brand === document.querySelector('.brand');
    }),
  ).toBe(true);
  await expect(page.locator('html')).toHaveClass(/indigo/);
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.locator('.top-nav').getByRole('link', { name: 'Feed' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await expect(
    page.locator('.top-nav').getByRole('link', { name: 'Feed' }),
  ).toHaveAttribute('aria-current', 'page');
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { brand?: Element | null };
      return state.brand === document.querySelector('.brand');
    }),
  ).toBe(true);

  await page.getByRole('button', { name: 'Interesting' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('etymology-feed');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const count = database
                .transaction('swipes')
                .objectStore('swipes')
                .count();
              count.onsuccess = () => {
                database.close();
                resolve(count.result);
              };
              count.onerror = () => reject(count.error);
            };
          }),
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const state = window as typeof window & { likedEmptySeen?: boolean };
    state.likedEmptySeen = false;
    new MutationObserver(() => {
      if (document.querySelector('.liked-empty')) state.likedEmptySeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await liked.click();
  await expect(page.locator('.liked-item')).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { likedEmptySeen?: boolean };
      return state.likedEmptySeen;
    }),
  ).toBe(false);
});

test('one fetched batch supports 100 offline swipes and survives reconnection', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  let feedFetches = 0;
  await page.context().route('**/api/feed?*', async (route) => {
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
  // The deck moves on before storage catches up; wait for every write to land.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const open = indexedDB.open('etymology-feed');
        const db = await new Promise<IDBDatabase>((resolve) => {
          open.onsuccess = () => resolve(open.result);
        });
        const count = db.transaction('swipes').objectStore('swipes').count();
        return new Promise<number>((resolve) => {
          count.onsuccess = () => resolve(count.result);
        });
      }),
    )
    .toBe(100);
  await page.goto('/liked/');
  await expect(page.locator('.liked-item')).toHaveCount(100);
  await expect(page.getByText('100 swipes waiting to sync')).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.liked-item')).toHaveCount(100);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const open = indexedDB.open('etymology-feed');
          const db = await new Promise<IDBDatabase>((resolve) => {
            open.onsuccess = () => resolve(open.result);
          });
          const request = db
            .transaction('swipes')
            .objectStore('swipes')
            .getAll();
          return new Promise<number>((resolve) => {
            request.onsuccess = () =>
              resolve(request.result.filter((swipe) => swipe.synced).length);
          });
        }),
      { timeout: 30_000 },
    )
    .toBe(100);
});

test('keyboard controls and undo work without a toast', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const first = await page.getByTestId('top-card').locator('h2').innerText();
  await page.keyboard.press('d');
  await expect(
    page.getByTestId('top-card').locator('.definition p'),
  ).not.toHaveClass(/is-clamped/);
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

test('Settings is its own page on a phone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const nav = page.locator('.bottom-nav');
  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings' }),
  ).toBeVisible();
  await expect(page.getByTestId('top-card')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('Always expand definitions')).toHaveCount(0);
  await nav.getByRole('link', { name: 'Feed' }).click();
  await expect(
    page.getByTestId('top-card').locator('.definition p'),
  ).toHaveClass(/is-clamped/);
  await page.reload();
  await expect(
    page.getByTestId('top-card').locator('.definition p'),
  ).toHaveClass(/is-clamped/);

  // An old overlay link on a phone lands on the page instead.
  await page.goto('/?settings=1');
  await expect(page).toHaveURL(/\/settings\/$/);
});

test('desktop Settings opens a centered dialog over Feed and Liked', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const word = await card.locator('h2').innerText();
  const settings = page.locator('.top-nav').getByRole('link', {
    name: 'Settings',
  });
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await settings.click();
  await expect(page).toHaveURL('/');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('radiogroup', { name: 'Color mode' }),
  ).toBeVisible();
  const bounds = await dialog.boundingBox();
  if (!bounds) throw new Error('Settings dialog has no visible bounds.');
  expect(Math.abs(bounds.x + bounds.width / 2 - 640)).toBeLessThan(2);
  expect(Math.abs(bounds.y + bounds.height / 2 - 400)).toBeLessThan(2);
  await expect(dialog.getByLabel('Always expand definitions')).toHaveCount(0);
  await expect(card.locator('.definition p')).toHaveClass(/is-clamped/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(card.locator('h2')).toHaveText(word);

  await page.goto('/liked/');
  await settings.click();
  await expect(page).toHaveURL('/liked/');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL('/liked/');
});

test('mobile dock tabs are centered, evenly spaced, and underline only the label', async ({
  page,
}) => {
  await page.goto('/');
  const dock = page.locator('.bottom-nav');
  const feed = dock.getByRole('link', { name: 'Feed' });
  await expect(feed).toHaveAttribute('aria-current', 'page');
  await expect(feed).toHaveCSS('text-decoration-line', 'none');
  await expect(feed.locator('.nav-label')).toHaveCSS(
    'text-decoration-line',
    'underline',
  );
  await expect(feed.locator('svg')).toHaveCount(1);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const dockBox = await dock.boundingBox();
    if (!dockBox) throw new Error('Dock has no visible bounds.');
    const links = await dock.getByRole('link').all();
    expect(links).toHaveLength(3);
    for (const [index, link] of links.entries()) {
      const linkBox = await link.boundingBox();
      const iconBox = await link.locator('svg').boundingBox();
      if (!linkBox || !iconBox)
        throw new Error('Dock tab has no visible bounds.');
      const center = linkBox.x + linkBox.width / 2;
      expect(center).toBeCloseTo(
        dockBox.x + (dockBox.width * (index + 0.5)) / 3,
        0,
      );
      expect(iconBox.x + iconBox.width / 2).toBeCloseTo(center, 0);
    }
  }
});

test('Settings icons and controls use the correct theme styles', async ({
  page,
}) => {
  await page.context().route('**/api/me', async (route) => {
    const response = await route.fetch();
    const account = await response.json();
    account.providers = ['google', 'github'];
    await route.fulfill({ response, json: account });
  });
  await page.goto('/settings/');
  const settingsLink = page.locator('.bottom-nav').getByRole('link', {
    name: 'Settings',
  });
  await expect(settingsLink.locator('svg')).toHaveCount(1);
  await expect(settingsLink).not.toContainText('⚙');
  await expect(page.locator('.topbar .account-badge')).toHaveCount(0);
  await expect(
    page.getByText(
      'Show names of people, places, and other named things in your feed.',
    ),
  ).toHaveCount(0);

  const account = page.locator('.account-section');
  await expect(
    account.getByText('Sign in to keep your Liked list across devices.'),
  ).toHaveCSS('font-family', /Instrument Sans/);
  for (const provider of ['Google', 'GitHub']) {
    const button = account.getByRole('button', {
      name: `Continue with ${provider}`,
    });
    await expect(button).toHaveCSS('border-top-width', '1px');
    await expect(button).toHaveCSS('border-top-color', 'rgb(232, 232, 237)');
  }
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCSS(
    'font-family',
    /Bricolage Grotesque/,
  );

  await page.getByRole('radio', { name: 'Technical' }).check();
  const switchInput = page.getByRole('switch', {
    name: 'Include proper nouns',
  });
  await expect(switchInput).toBeEnabled();
  await expect(switchInput).not.toBeChecked();
  await expect(switchInput).toHaveCSS('border-top-color', 'rgb(47, 94, 168)');
  await switchInput.evaluate((input) => {
    (input as HTMLInputElement).disabled = true;
  });
  await expect(switchInput).toHaveCSS('opacity', '0.85');

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.topbar > *')).toHaveCount(2);
});

test('the themes persist and system mode follows the device', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings/');
  const themePicker = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(themePicker).toBeVisible();
  const colorMode = page.getByRole('radiogroup', { name: 'Color mode' });
  const light = colorMode.getByRole('radio', { name: 'Light' });
  const dark = colorMode.getByRole('radio', { name: 'Dark' });
  const system = colorMode.getByRole('radio', { name: 'System' });
  await expect(system).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/gallery dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/gallery light/);
  await expect(page.getByLabel('Modern')).toBeChecked();

  await page.getByLabel('Romantic').check();
  await expect(page.locator('html')).toHaveClass(/nocturne light/);
  await dark.check();
  await expect(page.locator('html')).toHaveClass(/nocturne dark/);
  await page.reload();
  await expect(page.getByLabel('Romantic')).toBeChecked();
  await expect(dark).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/nocturne dark/);

  await page.emulateMedia({ colorScheme: 'dark' });
  await light.check();
  await expect(page.locator('html')).toHaveClass(/nocturne light/);
  await system.check();
  await expect(page.locator('html')).toHaveClass(/nocturne dark/);
  await page.reload();
  await expect(system).toBeChecked();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/nocturne light/);

  await page.getByLabel('Technical').check();
  await expect(page.locator('html')).toHaveClass(/indigo light/);
  await page.reload();
  await expect(themePicker).toBeVisible();
  await expect(page.getByLabel('Technical')).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/indigo light/);
  await page.goto('/liked/');
  await expect(page.locator('html')).toHaveClass(/indigo light/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    THEME_COLORS.indigo.light,
  );
});

test('Settings shows the saved choices before its client code loads', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('etymology-theme', 'indigo');
    localStorage.setItem('etymology-color-mode', 'dark');
  });
  await page.context().route('**/_astro/*.js', (route) => route.abort());
  await page.goto('/settings/');
  await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await expect(page.getByLabel('Technical')).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/indigo dark/);
});

/** A single finger on the touchscreen, driven through the browser's real
 * touch pipeline so touch-action and native scrolling take part. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  let at = { x: 0, y: 0 };
  const send = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: { x: number; y: number }[],
  ) => {
    return cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points,
    });
  };
  return {
    async down(x: number, y: number) {
      at = { x, y };
      await send('touchStart', [at]);
    },
    async move(x: number, y: number, { steps = 1, wait = 16 } = {}) {
      const from = at;
      for (let step = 1; step <= steps; step++) {
        at = {
          x: from.x + ((x - from.x) * step) / steps,
          y: from.y + ((y - from.y) * step) / steps,
        };
        await send('touchMove', [at]);
        await page.waitForTimeout(wait);
      }
    },
    async up() {
      await send('touchEnd', []);
    },
    async tap(x: number, y: number) {
      at = { x, y };
      await send('touchStart', [at]);
      await page.waitForTimeout(40);
      await send('touchEnd', []);
    },
    /** Chrome's own long-press gesture, which drives native selection. */
    async hold(x: number, y: number) {
      await cdp.send('Input.synthesizeTapGesture', {
        x,
        y,
        duration: 1000,
        gestureSourceType: 'touch',
      });
    },
  };
}

test('horizontal drag commits a swipe while vertical movement leaves the card in place', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const first = await card.locator('h2').innerText();
  const box = await card.boundingBox();
  if (!box) throw new Error('Card has no visible bounds.');
  // Start on the etymology text: it scrolls, but must not steal a swipe.
  const text = await card.locator('.etymology').boundingBox();
  if (!text) throw new Error('Etymology has no visible bounds.');
  const x = text.x + Math.min(text.width / 2, 40);
  const y = text.y + Math.min(text.height / 2, 12);
  const touch = await finger(page);
  await touch.down(x, y);
  await touch.move(x + 4, y + 85, { steps: 5 });
  await touch.up();
  await expect(card.locator('h2')).toHaveText(first);
  await touch.down(x, y);
  await touch.move(x + box.width * 0.48, y, { steps: 8 });
  await touch.up();
  // The card flying off-screen must not widen the page and let it pan.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(
    first,
  );
  await expect(page.locator('.is-departing')).toHaveCount(0);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: first })).toBeVisible();
});

for (const direction of [-1, 1]) {
  test(`diagonal swipe ${direction} keeps a long card from scrolling`, async ({
    page,
  }) => {
    await page.context().route('**/api/feed?*', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      for (const card of data.cards) {
        card.etymology =
          'A long word history for reading and scrolling. '.repeat(100);
      }
      await route.fulfill({ response, json: data });
    });
    await page.goto('/');
    const card = page.getByTestId('top-card');
    await expect(card).toBeVisible();
    const first = await card.locator('h2').innerText();
    const body = card.locator('.card-body');
    // Start midway through real overflowing content, away from scroll edges.
    await body.evaluate((element) => {
      element.scrollTop = 180;
    });
    const box = await body.boundingBox();
    if (!box) throw new Error('Card body has no visible bounds.');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const touch = await finger(page);
    await touch.down(x, y);
    // The initial diagonal has slightly more vertical than horizontal travel.
    await touch.move(x + direction * 20, y - 22);
    await touch.move(x + direction * 140, y - 100, { steps: 8 });
    await expect(page.locator('.deck-area')).toHaveClass(/is-dragging/);
    expect(await body.evaluate((element) => element.scrollTop)).toBe(180);
    await touch.up();
    await expect(card.locator('h2')).not.toHaveText(first);
  });
}

test('vertical reading stays locked to scrolling and card edges do not bounce', async ({
  page,
}) => {
  await page.context().route('**/api/feed?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const card of data.cards) {
      card.etymology = 'A long word history for reading and scrolling. '.repeat(
        100,
      );
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const first = await card.locator('h2').innerText();
  const body = card.locator('.card-body');
  await expect(body).toHaveCSS('overscroll-behavior-y', 'none');
  const box = await body.boundingBox();
  if (!box) throw new Error('Card body has no visible bounds.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const touch = await finger(page);
  await touch.down(x, y);
  await touch.move(x + 4, y - 90, { steps: 6 });
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  // Turning sideways after starting to read must not dismiss the card.
  await touch.move(x + 140, y - 95, { steps: 6 });
  await touch.up();
  await expect(card.locator('h2')).toHaveText(first);
  await expect(page.locator('.deck-area')).not.toHaveClass(/is-dragging/);
});

test('a short drag springs the card home with the next card in step', async ({
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
  const touch = await finger(page);
  await touch.down(x, y);
  await touch.move(x + box.width * 0.18, y, { steps: 6 });
  await page.waitForTimeout(150);
  await touch.up();
  await expect(card.locator('h2')).toHaveText(first);
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: first })).toHaveCount(0);
});

test('a mouse drag does not move the card', async ({ page }) => {
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
  await page.mouse.move(x + box.width * 0.48, y, { steps: 8 });
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.mouse.up();
  await expect(card.locator('h2')).toHaveText(first);
});

test('holding or double-tapping the text selects a word and holds the card still @native', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const first = await card.locator('h2').innerText();
  // Hit an actual glyph, independent of the runner's fonts and line metrics.
  const { x, y } = await card.locator('.etymology').evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent?.search(/\p{L}/u) ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error('Etymology has no selectable text.');
  });
  const selected = () => page.evaluate(() => getSelection()?.toString() ?? '');
  const touch = await finger(page);

  // Desktop Linux Chrome does not implement native touch long-press selection.
  // The macOS CI job covers it; app-provided double tap runs on both platforms.
  if (process.platform === 'darwin') {
    await touch.hold(x, y);
    await expect.poll(selected).toMatch(/^\S+$/);
    await touch.tap(x + 150, y + 150);
    await expect.poll(selected).toBe('');
  }

  await touch.tap(x, y);
  await page.waitForTimeout(90);
  await touch.tap(x, y);
  await expect.poll(selected).toMatch(/^\S+$/);

  // While text is selected, a sideways drag does not swipe.
  await touch.down(x, y);
  await touch.move(x + 180, y, { steps: 8 });
  await touch.up();
  await page.waitForTimeout(400);
  await expect(card.locator('h2')).toHaveText(first);

  // A tap clears the selection and swiping works again.
  await touch.tap(x + 150, y + 150);
  await expect.poll(selected).toBe('');
  await touch.down(x, y);
  await touch.move(x + 180, y, { steps: 8 });
  await touch.up();
  await expect(card.locator('h2')).not.toHaveText(first);
});

test('a drag past the commit point arms its button until it is pulled back', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const first = await card.locator('h2').innerText();
  const box = await card.boundingBox();
  if (!box) throw new Error('Card has no visible bounds.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.6;
  const like = page.getByRole('button', { name: 'Interesting' });
  const skip = page.getByRole('button', { name: 'Not for me' });
  const touch = await finger(page);

  await touch.down(x, y);
  await touch.move(x + box.width * 0.5, y, { steps: 12, wait: 40 });
  await expect(like).toHaveClass(/is-armed/);
  await expect(skip).not.toHaveClass(/is-armed/);
  await touch.move(x + box.width * 0.05, y, { steps: 12, wait: 40 });
  await expect(like).not.toHaveClass(/is-armed/);
  await touch.move(x - box.width * 0.5, y, { steps: 12, wait: 40 });
  await expect(skip).toHaveClass(/is-armed/);
  await expect(like).not.toHaveClass(/is-armed/);
  await touch.up();

  // The armed verdict is the one committed, and the cue clears afterward.
  await expect(card.locator('h2')).not.toHaveText(first);
  await expect(skip).not.toHaveClass(/is-armed/);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: first })).toHaveCount(0);
});
