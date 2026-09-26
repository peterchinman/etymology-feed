import type { Card } from '@etymology-feed/shared/card';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

export type Verdict = 1 | -1;
export type Palette = 'pink' | 'blue';
export type ColorMode = 'system' | 'light' | 'dark';
export type LocalSwipe = {
  id: string;
  word: string;
  verdict: Verdict;
  bucket: Card['bucket'];
  shownAt: number;
  swipedAt: number;
  synced: false;
  card: Card;
};

interface FeedDB extends DBSchema {
  stack: { key: string; value: Card[] };
  served: { key: string; value: string[] };
  swipes: {
    key: string;
    value: LocalSwipe;
    indexes: { 'by-word': string; 'by-swiped-at': number };
  };
  settings: { key: string; value: Palette | ColorMode | boolean };
}

let database: Promise<IDBPDatabase<FeedDB>> | undefined;
function getDatabase(): Promise<IDBPDatabase<FeedDB>> {
  database ??= openDB<FeedDB>('etymology-feed', 1, {
    upgrade(db) {
      db.createObjectStore('stack');
      db.createObjectStore('served');
      const swipes = db.createObjectStore('swipes', { keyPath: 'id' });
      swipes.createIndex('by-word', 'word');
      swipes.createIndex('by-swiped-at', 'swipedAt');
      db.createObjectStore('settings');
    },
  });
  return database;
}

export async function getStack(): Promise<Card[]> {
  return (await (await getDatabase()).get('stack', 'cards')) ?? [];
}

export async function getServed(): Promise<string[]> {
  return (await (await getDatabase()).get('served', 'words')) ?? [];
}

export async function appendCards(cards: Card[]): Promise<Card[]> {
  const db = await getDatabase();
  const tx = db.transaction(['stack', 'served'], 'readwrite');
  const [stack, served] = await Promise.all([
    tx.objectStore('stack').get('cards'),
    tx.objectStore('served').get('words'),
  ]);
  const nextStack = stack ?? [];
  const known = new Set(served ?? []);
  const nextServed = served ?? [];
  for (const card of cards) {
    if (known.has(card.word)) continue;
    known.add(card.word);
    nextServed.push(card.word);
    nextStack.push(card);
  }
  tx.objectStore('stack').put(nextStack, 'cards');
  tx.objectStore('served').put(nextServed, 'words');
  await tx.done;
  return nextStack;
}

export type PendingSwipe = { card: Card; verdict: Verdict; shownAt: number };

/**
 * Record swipes, oldest first, in one transaction. They must match the front
 * of the stored stack in order; a burst of quick swipes costs one write.
 */
export async function saveSwipes(
  pending: readonly PendingSwipe[],
): Promise<LocalSwipe[]> {
  const db = await getDatabase();
  const swipedAt = Date.now();
  const swipes = pending.map<LocalSwipe>(({ card, verdict, shownAt }) => ({
    id: crypto.randomUUID(),
    word: card.word,
    verdict,
    bucket: card.bucket,
    shownAt,
    swipedAt,
    synced: false,
    card,
  }));
  const tx = db.transaction(['stack', 'swipes'], 'readwrite');
  const stack = (await tx.objectStore('stack').get('cards')) ?? [];
  pending.forEach(({ card }, index) => {
    if (stack[index]?.word !== card.word) {
      throw new Error('The card stack changed before the swipe was saved.');
    }
  });
  tx.objectStore('stack').put(stack.slice(pending.length), 'cards');
  for (const swipe of swipes) tx.objectStore('swipes').put(swipe);
  await tx.done;
  return swipes;
}

export async function undoSwipe(swipe: LocalSwipe): Promise<Card[]> {
  const db = await getDatabase();
  const tx = db.transaction(['stack', 'swipes'], 'readwrite');
  const stack = (await tx.objectStore('stack').get('cards')) ?? [];
  const nextStack = [swipe.card, ...stack];
  tx.objectStore('stack').put(nextStack, 'cards');
  tx.objectStore('swipes').delete(swipe.id);
  await tx.done;
  return nextStack;
}

export async function getSwipes(): Promise<LocalSwipe[]> {
  return (await (await getDatabase()).getAll('swipes')).sort(
    (a, b) => b.swipedAt - a.swipedAt,
  );
}

export async function removeSwipe(id: string): Promise<void> {
  await (await getDatabase()).delete('swipes', id);
}

export async function getSettings(): Promise<{
  showDefinitions: boolean;
  palette: Palette;
  colorMode: ColorMode;
}> {
  const db = await getDatabase();
  const [showDefinitions, palette, colorMode, legacyTheme] = await Promise.all([
    db.get('settings', 'showDefinitions'),
    db.get('settings', 'palette'),
    db.get('settings', 'colorMode'),
    db.get('settings', 'theme'),
  ]);
  let mirroredPalette: string | null = null;
  let mirroredMode: string | null = null;
  try {
    mirroredPalette = localStorage.getItem('etymology-palette');
    mirroredMode =
      localStorage.getItem('etymology-color-mode') ||
      localStorage.getItem('etymology-theme');
  } catch {
    // IndexedDB is enough when the pre-paint mirror is unavailable.
  }
  const selectedPalette: Palette =
    mirroredPalette === 'pink' || mirroredPalette === 'blue'
      ? mirroredPalette
      : palette === 'blue'
        ? 'blue'
        : 'pink';
  const storedMode = colorMode ?? legacyTheme;
  const selectedMode: ColorMode =
    mirroredMode === 'light' || mirroredMode === 'dark'
      ? mirroredMode
      : storedMode === 'light' || storedMode === 'dark'
        ? storedMode
        : 'system';
  if (mirroredPalette && palette !== selectedPalette)
    await db.put('settings', selectedPalette, 'palette');
  if (mirroredMode && colorMode !== selectedMode)
    await db.put('settings', selectedMode, 'colorMode');
  return {
    showDefinitions: showDefinitions === true,
    palette: selectedPalette,
    colorMode: selectedMode,
  };
}

export async function setShowDefinitions(value: boolean): Promise<void> {
  await (await getDatabase()).put('settings', value, 'showDefinitions');
}

export function applyTheme(palette: Palette, mode: ColorMode): boolean {
  const root = document.documentElement;
  const dark =
    mode === 'dark' ||
    (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.remove('pink', 'blue', 'light', 'dark');
  root.classList.add(palette, dark ? 'dark' : 'light');
  root.dataset.colorMode = mode;
  const canvas = getComputedStyle(root)
    .getPropertyValue('--color-canvas')
    .trim();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', canvas);
  return dark;
}

export async function setPalette(value: Palette): Promise<void> {
  const mode = document.documentElement.dataset.colorMode;
  applyTheme(value, mode === 'light' || mode === 'dark' ? mode : 'system');
  try {
    localStorage.setItem('etymology-palette', value);
  } catch {
    // IndexedDB remains the persistent setting when localStorage is unavailable.
  }
  await (await getDatabase()).put('settings', value, 'palette');
}

export async function setColorMode(
  value: Exclude<ColorMode, 'system'>,
): Promise<void> {
  applyTheme(
    document.documentElement.classList.contains('blue') ? 'blue' : 'pink',
    value,
  );
  try {
    localStorage.setItem('etymology-color-mode', value);
  } catch {
    // The current page can still switch themes when localStorage is unavailable.
  }
  await (await getDatabase()).put('settings', value, 'colorMode');
}
