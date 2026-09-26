import type { Card } from '@etymology-feed/shared/card';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

export type Verdict = 1 | -1;
export type Theme = 'system' | 'light' | 'dark';
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
  settings: { key: string; value: Theme | boolean };
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

export async function saveSwipe(
  card: Card,
  verdict: Verdict,
  shownAt: number,
): Promise<LocalSwipe> {
  const db = await getDatabase();
  const swipe: LocalSwipe = {
    id: crypto.randomUUID(),
    word: card.word,
    verdict,
    bucket: card.bucket,
    shownAt,
    swipedAt: Date.now(),
    synced: false,
    card,
  };
  const tx = db.transaction(['stack', 'swipes'], 'readwrite');
  const stack = (await tx.objectStore('stack').get('cards')) ?? [];
  if (stack[0]?.word !== card.word) {
    throw new Error('The card stack changed before the swipe was saved.');
  }
  tx.objectStore('stack').put(stack.slice(1), 'cards');
  tx.objectStore('swipes').put(swipe);
  await tx.done;
  return swipe;
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
  theme: Theme;
}> {
  const db = await getDatabase();
  const [showDefinitions, theme] = await Promise.all([
    db.get('settings', 'showDefinitions'),
    db.get('settings', 'theme'),
  ]);
  return {
    showDefinitions: showDefinitions === true,
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
  };
}

export async function setShowDefinitions(value: boolean): Promise<void> {
  await (await getDatabase()).put('settings', value, 'showDefinitions');
}

export async function setTheme(value: Theme): Promise<void> {
  await (await getDatabase()).put('settings', value, 'theme');
  localStorage.setItem('etymology-theme', value);
  document.documentElement.dataset.theme = value;
}
