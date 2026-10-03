import { waitForSavedSwipes } from './helpers/cards';
import { expect, test } from './helpers/test';

const firstVisit = { cookies: [], origins: [] };
// Every other spec starts past the welcome; this one starts as a new visitor.
test.use({ storageState: firstVisit });

const tagline = 'Stories are made of words. Words are made of stories.';

test('a first visit opens on a welcome card that dismisses without a like', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  const welcome = page.getByRole('heading', { name: tagline });
  await expect(welcome).toBeVisible();
  await expect(
    page.getByText('If you like it, swipe right.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('press the heart', { exact: false })).toHaveCount(
    0,
  );

  // It stays until it is dismissed, even after the first stack is saved.
  await page.reload();
  await expect(welcome).toBeVisible();

  const like = page.getByRole('button', { name: 'Interesting', exact: true });
  await expect(like).toBeEnabled();
  await like.click();
  await expect(welcome).toHaveCount(0);
  const top = page.getByTestId('top-card').locator('h2');
  await expect(top).toBeVisible();
  const word = await top.innerText();
  await like.click();
  await waitForSavedSwipes(page, 1);
  await page.goto('/liked/');
  await expect(page.locator('.liked-item')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: word })).toBeVisible();
  await page.goto('/');
  await expect(top).toBeVisible();
  await expect(welcome).toHaveCount(0);

  // Without a touchscreen there is nothing to swipe, so it points to buttons.
  const desktop = await browser.newContext({
    hasTouch: false,
    isMobile: false,
    viewport: { width: 1280, height: 800 },
    storageState: firstVisit,
  });
  try {
    const other = await desktop.newPage();
    await other.goto('/');
    const otherWelcome = other.getByRole('heading', { name: tagline });
    await expect(otherWelcome).toBeVisible();
    await expect(
      other.getByText('If you like it, press the heart.', { exact: false }),
    ).toBeVisible();
    await expect(other.getByText('swipe right', { exact: false })).toHaveCount(
      0,
    );
    await expect(
      other.getByRole('button', { name: 'Not for me', exact: true }),
    ).toBeEnabled();
    await other.keyboard.press('ArrowLeft');
    await expect(otherWelcome).toHaveCount(0);
  } finally {
    await desktop.close();
  }
});
