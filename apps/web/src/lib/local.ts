import type { Card } from '@etymology-feed/shared/card';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import {
  DEFAULT_THEME,
  isTheme,
  THEME_COLORS,
  THEMES,
  type Theme,
} from './themes';

export type Verdict = 1 | -1;
export type ColorMode = 'system' | 'light' | 'dark';
export type LocalSwipe = {
  id: string;
  word: string;
  verdict: Verdict;
  bucket: Card['bucket'];
  shownAt: number;
  swipedAt: number;
  synced: boolean;
  removed?: boolean;
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
  settings: { key: string; value: string | boolean };
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

export async function getUnsyncedSwipes(): Promise<LocalSwipe[]> {
  return (await getSwipes())
    .filter((swipe) => !swipe.synced && !swipe.removed)
    .slice(0, 500);
}

export async function markSwipesSynced(ids: readonly string[]): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction('swipes', 'readwrite');
  for (const id of ids) {
    const swipe = await tx.store.get(id);
    if (swipe) await tx.store.put({ ...swipe, synced: true });
  }
  await tx.done;
}

export async function removeSwipe(id: string): Promise<void> {
  const db = await getDatabase();
  const swipe = await db.get('swipes', id);
  if (!swipe) return;
  await db.put('swipes', { ...swipe, removed: true });
}

export async function getPendingRemovals(): Promise<LocalSwipe[]> {
  return (await getSwipes()).filter((swipe) => swipe.removed === true);
}

export async function confirmRemoval(id: string): Promise<void> {
  await (await getDatabase()).delete('swipes', id);
}

function isMode(value: unknown): value is Exclude<ColorMode, 'system'> {
  return value === 'light' || value === 'dark';
}

function mirror(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // IndexedDB remains the persistent setting when localStorage is unavailable.
  }
}

export async function getSettings(): Promise<{
  showDefinitions: boolean;
  theme: Theme;
  colorMode: ColorMode;
}> {
  const db = await getDatabase();
  const [showDefinitions, storedTheme, storedMode] = await Promise.all([
    db.get('settings', 'showDefinitions'),
    db.get('settings', 'theme'),
    db.get('settings', 'colorMode'),
  ]);
  let mirroredTheme: string | null = null;
  let mirroredMode: string | null = null;
  try {
    mirroredTheme = localStorage.getItem('etymology-theme');
    mirroredMode = localStorage.getItem('etymology-color-mode');
  } catch {
    // IndexedDB is enough when the pre-paint mirror is unavailable.
  }
  const theme: Theme = isTheme(mirroredTheme)
    ? mirroredTheme
    : isTheme(storedTheme)
      ? storedTheme
      : DEFAULT_THEME;
  // Before the theme picker, `theme` held the light/dark choice. Honor it
  // until a color mode has been saved on its own, then move it over.
  const legacyMode = isMode(mirroredTheme)
    ? mirroredTheme
    : isMode(storedTheme)
      ? storedTheme
      : null;
  const colorMode: ColorMode = isMode(mirroredMode)
    ? mirroredMode
    : isMode(storedMode)
      ? storedMode
      : (legacyMode ?? 'system');
  if (legacyMode && colorMode === legacyMode) {
    mirror('etymology-color-mode', legacyMode);
    await db.put('settings', legacyMode, 'colorMode');
  }
  if (isTheme(mirroredTheme) && storedTheme !== theme)
    await db.put('settings', theme, 'theme');
  if (isMode(mirroredMode) && storedMode !== colorMode)
    await db.put('settings', colorMode, 'colorMode');
  return { showDefinitions: showDefinitions === true, theme, colorMode };
}

export async function setShowDefinitions(value: boolean): Promise<void> {
  await (await getDatabase()).put('settings', value, 'showDefinitions');
}

export function applyTheme(theme: Theme, mode: ColorMode): boolean {
  const root = document.documentElement;
  const dark =
    mode === 'dark' ||
    (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.remove(...THEMES.map((option) => option.id), 'light', 'dark');
  root.classList.add(theme, dark ? 'dark' : 'light');
  root.dataset.colorMode = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[theme][dark ? 'dark' : 'light']);
  return dark;
}

function currentTheme(): Theme {
  const root = document.documentElement;
  return (
    THEMES.find((option) => root.classList.contains(option.id))?.id ??
    DEFAULT_THEME
  );
}

function currentMode(): ColorMode {
  const mode = document.documentElement.dataset.colorMode;
  return isMode(mode) ? mode : 'system';
}

export async function setTheme(value: Theme): Promise<void> {
  applyTheme(value, currentMode());
  mirror('etymology-theme', value);
  await (await getDatabase()).put('settings', value, 'theme');
}

export async function setColorMode(
  value: Exclude<ColorMode, 'system'>,
): Promise<void> {
  applyTheme(currentTheme(), value);
  mirror('etymology-color-mode', value);
  await (await getDatabase()).put('settings', value, 'colorMode');
}
