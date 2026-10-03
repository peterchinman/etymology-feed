import { type Card, isFeedEligible } from '@etymology-feed/shared/card';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import { withRefreshedCount } from './likes';
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
  cardId: string;
  word: string;
  verdict: Verdict;
  bucket: Card['bucket'];
  shownAt: number;
  swipedAt: number;
  synced: boolean;
  removed?: boolean;
  card: Card;
  /**
   * True when card.likeCount was read from the server after this like synced,
   * so the total already counts it. Feed and search snapshots predate the like.
   */
  countIncludesSelf?: boolean;
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
const STACK_PREVIEW_KEY = 'etymology-stack-preview';

function normalizeCard(card: Card): Card {
  return { ...card, id: card.id ?? card.word, etymNo: card.etymNo ?? null };
}

function cacheStackPreview(cards: readonly Card[]): void {
  try {
    if (cards.length) {
      localStorage.setItem(
        STACK_PREVIEW_KEY,
        JSON.stringify(cards.slice(0, 2)),
      );
    } else {
      localStorage.removeItem(STACK_PREVIEW_KEY);
    }
  } catch {
    // IndexedDB remains the source of truth when localStorage is unavailable.
  }
}

export function getStackPreview(): Card[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STACK_PREVIEW_KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored
      .slice(0, 2)
      .filter(
        (card): card is Card =>
          card &&
          typeof card.word === 'string' &&
          typeof card.definition === 'string' &&
          typeof card.defPos === 'string' &&
          typeof card.etymology === 'string',
      )
      .map(normalizeCard);
  } catch {
    return [];
  }
}

function normalizeSwipe(swipe: LocalSwipe): LocalSwipe {
  return {
    ...swipe,
    cardId: swipe.cardId ?? swipe.word,
    card: normalizeCard(swipe.card),
  };
}
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
  const cards = ((await (await getDatabase()).get('stack', 'cards')) ?? []).map(
    normalizeCard,
  );
  cacheStackPreview(cards);
  return cards;
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
  const nextStack = (stack ?? []).map(normalizeCard);
  const known = new Set(served ?? []);
  const nextServed = served ?? [];
  for (const incoming of cards) {
    const card = normalizeCard(incoming);
    if (known.has(card.id)) continue;
    known.add(card.id);
    nextServed.push(card.id);
    nextStack.push(card);
  }
  tx.objectStore('stack').put(nextStack, 'cards');
  tx.objectStore('served').put(nextServed, 'words');
  await tx.done;
  cacheStackPreview(nextStack);
  return nextStack;
}

export type PendingSwipe = { card: Card; verdict: Verdict; shownAt: number };

/**
 * Record swipes in display order. Hidden proper nouns stay in the stored stack
 * so enabling them again works offline; a burst costs one write.
 */
export async function saveSwipes(
  pending: readonly PendingSwipe[],
): Promise<LocalSwipe[]> {
  const db = await getDatabase();
  const swipedAt = Date.now();
  const swipes = pending.map<LocalSwipe>(({ card, verdict, shownAt }) => ({
    id: crypto.randomUUID(),
    cardId: card.id,
    word: card.word,
    verdict,
    bucket: card.bucket,
    shownAt,
    swipedAt,
    synced: false,
    card,
  }));
  const tx = db.transaction(['stack', 'swipes'], 'readwrite');
  // Only records without an ID use the legacy headword identity. An explicit
  // etymology ID must never match a sibling just because its word is the same.
  const stack = ((await tx.objectStore('stack').get('cards')) ?? []).map(
    normalizeCard,
  );
  let index = 0;
  const consumed = new Set<string>();
  for (const { card } of pending) {
    while (
      stack[index] &&
      stack[index].id !== card.id &&
      !isFeedEligible(stack[index])
    )
      index++;
    if (stack[index]?.id !== card.id) {
      throw new Error('The card stack changed before the swipe was saved.');
    }
    consumed.add(stack[index].id);
    index++;
  }
  const nextStack = stack.filter((card) => !consumed.has(card.id));
  tx.objectStore('stack').put(nextStack, 'cards');
  for (const swipe of swipes) tx.objectStore('swipes').put(swipe);
  await tx.done;
  cacheStackPreview(nextStack);
  return swipes;
}

export async function undoSwipe(swipe: LocalSwipe): Promise<Card[]> {
  const db = await getDatabase();
  const tx = db.transaction(['stack', 'swipes'], 'readwrite');
  const stack = (await tx.objectStore('stack').get('cards')) ?? [];
  const nextStack = [normalizeCard(swipe.card), ...stack.map(normalizeCard)];
  tx.objectStore('stack').put(nextStack, 'cards');
  tx.objectStore('swipes').delete(swipe.id);
  await tx.done;
  cacheStackPreview(nextStack);
  return nextStack;
}

/** Save a search result without requiring it to be the top feed card. */
export async function saveSearchLike(card: Card): Promise<LocalSwipe> {
  const db = await getDatabase();
  const tx = db.transaction(['swipes', 'stack', 'served'], 'readwrite');
  const store = tx.objectStore('swipes');
  const previous = (await store.index('by-word').getAll(card.word))
    .map(normalizeSwipe)
    .filter((swipe) => swipe.cardId === card.id)
    .sort((a, b) => b.swipedAt - a.swipedAt);
  const latest = previous[0];
  if (latest?.verdict === 1 && !latest.removed) {
    await tx.done;
    return latest;
  }
  const now = Date.now();
  const swipe: LocalSwipe = {
    id: crypto.randomUUID(),
    cardId: card.id,
    word: card.word,
    verdict: 1,
    bucket: undefined,
    shownAt: now,
    swipedAt: Math.max(now, (latest?.swipedAt ?? 0) + 1),
    synced: false,
    card,
  };
  for (const old of previous) await store.delete(old.id);
  await store.put(swipe);
  const stack = ((await tx.objectStore('stack').get('cards')) ?? []).map(
    normalizeCard,
  );
  const nextStack = stack.filter((item) => item.id !== card.id);
  await tx.objectStore('stack').put(nextStack, 'cards');
  const served = (await tx.objectStore('served').get('words')) ?? [];
  if (!served.includes(card.id)) {
    served.push(card.id);
    await tx.objectStore('served').put(served, 'words');
  }
  await tx.done;
  cacheStackPreview(nextStack);
  return swipe;
}

/**
 * Unlike a search result. Marks its current like removed, as the Liked page
 * does, so the next sync deletes it on the server.
 */
export async function removeSearchLike(card: Card): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction('swipes', 'readwrite');
  const store = tx.objectStore('swipes');
  const latest = (await store.index('by-word').getAll(card.word))
    .map(normalizeSwipe)
    .filter((swipe) => swipe.cardId === card.id)
    .sort((a, b) => b.swipedAt - a.swipedAt)[0];
  if (latest?.verdict === 1 && !latest.removed)
    await store.put({ ...latest, removed: true });
  await tx.done;
}

export async function getSwipes(): Promise<LocalSwipe[]> {
  return (await (await getDatabase()).getAll('swipes'))
    .map(normalizeSwipe)
    .sort((a, b) => b.swipedAt - a.swipedAt);
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

export async function replaceLikedFromServer(
  likes: readonly {
    id: string;
    cardId: string;
    shownAt: number;
    swipedAt: number;
    card: Card;
  }[],
): Promise<LocalSwipe[]> {
  const db = await getDatabase();
  const tx = db.transaction('swipes', 'readwrite');
  const store = tx.objectStore('swipes');
  const existing = (await store.getAll()).map(normalizeSwipe);
  const serverCards = new Set(likes.map(({ cardId }) => cardId));
  for (const swipe of existing)
    if (swipe.verdict === 1 || serverCards.has(swipe.cardId))
      await store.delete(swipe.id);
  for (const like of likes)
    await store.put({
      id: like.id,
      cardId: like.cardId,
      word: like.card.word,
      verdict: 1,
      bucket: like.card.bucket,
      shownAt: like.shownAt,
      swipedAt: like.swipedAt,
      synced: true,
      card: normalizeCard(like.card),
      countIncludesSelf: true,
    });
  await tx.done;
  return getSwipes();
}

/** Store fresh server totals on liked cards so Liked shows them offline too. */
export async function saveLikeCounts(
  counts: Readonly<Record<string, number>>,
  counted: ReadonlySet<string>,
): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction('swipes', 'readwrite');
  for (const swipe of await tx.store.getAll()) {
    const count = counts[swipe.cardId];
    if (swipe.verdict !== 1 || swipe.removed || count === undefined) continue;
    await tx.store.put(withRefreshedCount(swipe, count, counted));
  }
  await tx.done;
}

export async function clearAccountData(): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(['stack', 'served', 'swipes'], 'readwrite');
  tx.objectStore('stack').clear();
  tx.objectStore('served').clear();
  tx.objectStore('swipes').clear();
  await tx.done;
  cacheStackPreview([]);
}

function isMode(value: unknown): value is Exclude<ColorMode, 'system'> {
  return value === 'light' || value === 'dark';
}

function isColorMode(value: unknown): value is ColorMode {
  return value === 'system' || isMode(value);
}

function mirror(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // IndexedDB remains the persistent setting when localStorage is unavailable.
  }
}

export async function getSettings(): Promise<{
  theme: Theme;
  colorMode: ColorMode;
  includeProperNouns: boolean;
}> {
  const db = await getDatabase();
  const [storedTheme, storedMode, includeProperNouns] = await Promise.all([
    db.get('settings', 'theme'),
    db.get('settings', 'colorMode'),
    db.get('settings', 'includeProperNouns'),
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
  const colorMode: ColorMode = isColorMode(mirroredMode)
    ? mirroredMode
    : isColorMode(storedMode)
      ? storedMode
      : (legacyMode ?? 'system');
  if (legacyMode && colorMode === legacyMode) {
    mirror('etymology-color-mode', legacyMode);
    await db.put('settings', legacyMode, 'colorMode');
  }
  if (isTheme(mirroredTheme) && storedTheme !== theme)
    await db.put('settings', theme, 'theme');
  if (isColorMode(mirroredMode) && storedMode !== colorMode)
    await db.put('settings', colorMode, 'colorMode');
  return { theme, colorMode, includeProperNouns: includeProperNouns === true };
}

export const FEED_SETTINGS_CHANGED = 'etymology:feed-settings-changed';

export async function setIncludeProperNouns(value: boolean): Promise<void> {
  await (await getDatabase()).put('settings', value, 'includeProperNouns');
  window.dispatchEvent(new Event(FEED_SETTINGS_CHANGED));
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
  return isColorMode(mode) ? mode : 'system';
}

export async function setTheme(value: Theme): Promise<void> {
  applyTheme(value, currentMode());
  mirror('etymology-theme', value);
  await (await getDatabase()).put('settings', value, 'theme');
}

export async function setColorMode(value: ColorMode): Promise<void> {
  applyTheme(currentTheme(), value);
  mirror('etymology-color-mode', value);
  await (await getDatabase()).put('settings', value, 'colorMode');
}
