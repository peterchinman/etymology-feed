import type { Card } from '@etymology-feed/shared/card';
import { putCardsOnStack, waitForSavedSwipes } from './helpers/cards';
import { expect, test } from './helpers/test';

test('Liked cards expand text in the page flow and share the Feed footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const response = await page.request.get('/api/words/bluff/etymologies');
  expect(response.ok()).toBe(true);
  const { cards } = (await response.json()) as { cards: Card[] };
  expect(cards).toHaveLength(2);

  const definition =
    'A paired definition that continues onto another line. '.repeat(12);
  const etymology =
    'A long origin story that is worth reading in full. '.repeat(20);
  const first = { ...cards[0], definition, etymology, likeCount: 1234 };
  const second = { ...cards[1], likeCount: 0 };
  await putCardsOnStack(page, [first, second]);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await waitForSavedSwipes(
    page,
    2,
    cards.map(({ id }) => id),
  );
  await page.goto('/liked/');

  const items = page.locator('.liked-item');
  await expect(items).toHaveCount(2);
  const longCard = items.nth(1);
  const shortCard = items.nth(0);
  await expect(longCard.locator('.definition p')).toHaveText(definition.trim());
  await expect(longCard.locator('.liked-etymology p')).toHaveText(
    etymology.trim(),
  );
  await expect(shortCard.locator('.card-like-count')).toHaveCount(0);
  await expect(longCard.locator('.card-like-count')).toHaveText(
    'Liked by 1,234 users',
  );
  const source = longCard.getByRole('link', { name: 'Wiktionary' });
  await expect(source).toHaveAttribute(
    'href',
    `https://en.wiktionary.org/wiki/bluff${first.etymNo ? `#Etymology_${first.etymNo}` : ''}`,
  );
  const definitionBox = await longCard.locator('.definition').boundingBox();
  const titleBox = await longCard.locator('h2').boundingBox();
  const etymologyBox = await longCard.locator('.liked-etymology').boundingBox();
  const sourceBox = await source.boundingBox();
  const countBox = await longCard.locator('.card-like-count').boundingBox();
  if (!titleBox || !definitionBox || !etymologyBox || !sourceBox || !countBox)
    throw new Error('A Liked card section is missing.');
  expect(definitionBox.y).toBeGreaterThan(titleBox.y);
  expect(etymologyBox.y).toBeGreaterThan(definitionBox.y);
  expect(sourceBox.y).toBeGreaterThan(etymologyBox.y);
  expect(sourceBox.x + sourceBox.width).toBeLessThan(countBox.x);
  expect(Math.abs(sourceBox.y - countBox.y)).toBeLessThan(5);

  const moreDefinition = longCard.getByRole('button', {
    name: 'See more definition',
  });
  const moreEtymology = longCard.getByRole('button', {
    name: 'See more etymology',
  });
  await expect(moreDefinition).toHaveAttribute('aria-expanded', 'false');
  await expect(moreEtymology).toHaveAttribute('aria-expanded', 'false');
  const previewHeight = await longCard
    .locator('.liked-etymology p')
    .evaluate((element) => element.getBoundingClientRect().height);
  await moreEtymology.click();
  await expect(
    longCard.getByRole('button', { name: 'See less etymology' }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(
    await longCard
      .locator('.liked-etymology p')
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThan(previewHeight);
  await longCard.getByRole('button', { name: 'See less etymology' }).click();
  await moreDefinition.click();
  await expect(
    longCard.getByRole('button', { name: 'See less definition' }),
  ).toHaveAttribute('aria-expanded', 'true');

  await longCard.locator('.liked-etymology').hover();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  expect(beforeScroll).toBeGreaterThan(0);
  await page.mouse.wheel(0, -240);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeLessThan(beforeScroll);
  expect(
    await longCard
      .locator('.liked-etymology')
      .evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe('visible');
  expect(
    await longCard
      .locator('.liked-etymology')
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
});
