import { expect, type Page, test } from '@playwright/test';
import { SWIPE } from '../src/lib/swipe';
import { THEME_COLORS } from '../src/lib/themes';

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
    page.getByRole('button', { name: 'Hide definition' }),
  ).toBeVisible();
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

test('Settings is its own page on a phone and the definition choice reaches the feed', async ({
  page,
}) => {
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
  await page.getByLabel('Always show definitions').check();
  await nav.getByRole('link', { name: 'Feed' }).click();
  await expect(
    page.getByRole('button', { name: 'Hide definition' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Hide definition' }),
  ).toBeVisible();

  // An old overlay link on a phone lands on the page instead.
  await page.goto('/?settings=1');
  await expect(page).toHaveURL(/\/settings\/$/);
});

test('the active dock tab underlines its label, not its icon', async ({
  page,
}) => {
  await page.goto('/');
  const feed = page.locator('.bottom-nav').getByRole('link', { name: 'Feed' });
  await expect(feed).toHaveAttribute('aria-current', 'page');
  await expect(feed).toHaveCSS('text-decoration-line', 'none');
  await expect(feed.locator('.nav-label')).toHaveCSS(
    'text-decoration-line',
    'underline',
  );
  await expect(feed.locator('.nav-icon')).toHaveCSS(
    'text-decoration-line',
    'none',
  );
});

test('the themes persist and system mode follows the device', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings/');
  await expect(page.locator('html')).toHaveClass(/gallery dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/gallery light/);
  await expect(page.getByLabel('Gallery')).toBeChecked();

  await page.getByLabel('Nocturne').check();
  await expect(page.locator('html')).toHaveClass(/nocturne light/);
  await page.getByLabel('Dark mode').check();
  await expect(page.locator('html')).toHaveClass(/nocturne dark/);
  await page.reload();
  await expect(page.getByLabel('Nocturne')).toBeChecked();
  await expect(page.getByLabel('Dark mode')).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/nocturne dark/);

  await page.getByLabel('Indigo').check();
  await expect(page.locator('html')).toHaveClass(/indigo dark/);
  await page.goto('/liked/');
  await expect(page.locator('html')).toHaveClass(/indigo dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    THEME_COLORS.indigo.dark,
  );
});

type RecordedAnimation = {
  id: string;
  word: string;
  duration: number;
  easing: string;
  from: string;
  to: string;
  playState: string;
};

/** Wrap Element.prototype.animate so tests can read back what the deck ran. */
async function recordAnimations(page: Page) {
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    const log: Animation[] = [];
    (window as unknown as { __animations: Animation[] }).__animations = log;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      const animation = original.call(this, keyframes, options);
      log.push(animation);
      return animation;
    };
  });
}

function readAnimations(page: Page): Promise<RecordedAnimation[]> {
  return page.evaluate(() =>
    (window as unknown as { __animations: Animation[] }).__animations.map(
      (animation) => {
        const effect = animation.effect as KeyframeEffect;
        const frames = effect.getKeyframes();
        return {
          id: animation.id,
          word:
            (effect.target as Element).querySelector('h2')?.textContent ?? '',
          duration: Number(effect.getTiming().duration),
          easing: effect.getTiming().easing ?? '',
          from: String(frames[0]?.transform ?? ''),
          to: String(frames[frames.length - 1]?.transform ?? ''),
          playState: animation.playState,
        };
      },
    ),
  );
}

/** Largest horizontal offset the top card shows over the next dozen frames. */
function topCardDrift(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let maximum = 0;
    for (let frame = 0; frame < 12; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const top = document.querySelector('[data-testid="top-card"]');
      if (!top) throw new Error('Top card is missing.');
      const transform = getComputedStyle(top).transform;
      maximum = Math.max(
        maximum,
        Math.abs(new DOMMatrixReadOnly(transform).m41),
      );
    }
    return maximum;
  });
}

/** A single finger on the touchscreen, driven through the browser's real
 * touch pipeline so touch-action and native scrolling take part. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  let at = { x: 0, y: 0 };
  const send = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: { x: number; y: number }[],
  ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
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
  await recordAnimations(page);
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
  const exits = (await readAnimations(page)).filter((a) => a.id === 'exit');
  expect(exits).toHaveLength(1);
  expect(exits[0].word).toBe(first);
  expect(exits[0].to).toMatch(/^translate\(\d+(\.\d+)?px/);
  expect(exits[0].duration).toBeLessThanOrEqual(SWIPE.exitMax);
  await expect(page.locator('.is-departing')).toHaveCount(0);
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: first })).toBeVisible();
});

test('the next card waits fully drawn and takes over without sliding back', async ({
  page,
}) => {
  await page.goto('/');
  const top = page.getByTestId('top-card');
  await expect(top).toBeVisible();
  const next = page.locator('.is-next');
  await expect(next).toHaveCount(1);
  await expect(next).toHaveCSS('opacity', '1');
  await expect(next.locator('.word-head')).toHaveCSS('opacity', '1');
  await expect(next).toHaveAttribute('aria-hidden', 'true');
  const nextWord = await next.locator('h2').innerText();
  await recordAnimations(page);
  await page.getByRole('button', { name: 'Interesting' }).click();
  await expect(top.locator('h2')).toHaveText(nextWord);
  expect(await topCardDrift(page)).toBeLessThan(1);
  const animations = await readAnimations(page);
  const exit = animations.find((a) => a.id === 'exit');
  const rise = animations.find((a) => a.id === 'rise');
  expect(exit?.duration).toBe(SWIPE.press.duration);
  expect(exit?.to).toMatch(/rotate\(/);
  expect(rise?.word).toBe(nextWord);
  expect(rise?.duration).toBe(SWIPE.press.duration);
  await expect(page.locator('.is-departing')).toHaveCount(0);
  await expect(page.locator('.is-next')).toHaveCount(1);
  await expect(page.locator('.is-next h2')).not.toHaveText(nextWord);
});

test('the exit speed follows the hand: a slow drag eases away, a flick leaves fast', async ({
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
  await recordAnimations(page);
  const touch = await finger(page);
  await touch.down(x, y);
  await touch.move(x + box.width * 0.45, y, { steps: 10, wait: 60 });
  await touch.up();
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(
    first,
  );
  const slow = (await readAnimations(page)).find((a) => a.id === 'exit');
  expect(slow?.word).toBe(first);
  expect(slow?.duration).toBe(SWIPE.exitMax);

  const second = await page.getByTestId('top-card').locator('h2').innerText();
  await touch.down(x, y);
  await touch.move(x + box.width * 0.4, y, { steps: 3, wait: 0 });
  await touch.up();
  await expect(page.getByTestId('top-card').locator('h2')).not.toHaveText(
    second,
  );
  const exits = (await readAnimations(page)).filter((a) => a.id === 'exit');
  expect(exits).toHaveLength(2);
  expect(exits[1].word).toBe(second);
  expect(exits[1].duration).toBeLessThan(SWIPE.exitMax);
  expect(exits[1].duration).toBeGreaterThanOrEqual(SWIPE.exitMin);
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
  await recordAnimations(page);
  const touch = await finger(page);
  await touch.down(x, y);
  await touch.move(x + box.width * 0.18, y, { steps: 6 });
  await page.waitForTimeout(150);
  await touch.up();
  await expect(card.locator('h2')).toHaveText(first);
  const snaps = (await readAnimations(page)).filter((a) => a.id === 'snap');
  expect(snaps).toHaveLength(2);
  expect(snaps[0].easing.startsWith('linear(')).toBe(true);
  expect(snaps[0].from).toMatch(/^matrix\(/);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.getAnimations().filter((a) => a.id === 'snap').length,
      ),
    )
    .toBe(0);
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  const peek = await page
    .locator('.is-next')
    .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform));
  expect(peek.a).toBeCloseTo(0.96, 3);
  expect(peek.f).toBeGreaterThan(0);
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

test('holding or double-tapping the text selects a word and holds the card still', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const first = await card.locator('h2').innerText();
  const text = await card.locator('.etymology').boundingBox();
  if (!text) throw new Error('Etymology has no visible bounds.');
  // Just inside the first word of the etymology.
  const x = text.x + 12;
  const y = text.y + 12;
  const selected = () => page.evaluate(() => getSelection()?.toString() ?? '');
  const touch = await finger(page);

  await touch.hold(x, y);
  await expect.poll(selected).toMatch(/^\S+$/);
  await touch.tap(x + 150, y + 150);
  await expect.poll(selected).toBe('');

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
