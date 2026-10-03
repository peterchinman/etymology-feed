import type { Card } from '@etymology-feed/shared/card';
import { authClient, ensureAnonymousSession, resetAuthSession } from './auth';
import { countedLikeIds } from './likes';
import {
  clearAccountData,
  getSwipes,
  type LocalSwipe,
  replaceLikedFromServer,
  saveLikeCounts,
} from './local';
import { drainSync } from './sync';

export type AccountInfo = {
  user: {
    id: string;
    isAnonymous: boolean;
    name: string;
    image: string | null;
  };
  providers: string[];
};

export async function getAccount(): Promise<AccountInfo> {
  await ensureAnonymousSession();
  const response = await fetch('/api/me');
  if (!response.ok) throw new Error('Could not load account.');
  return (await response.json()) as AccountInfo;
}

export async function startSignIn(
  provider: 'google' | 'github' | 'mock',
): Promise<void> {
  await ensureAnonymousSession();
  const result = await authClient.signIn.social({
    provider,
    callbackURL: '/liked/',
  });
  if (result.error)
    throw new Error(result.error.message ?? 'Sign-in could not start.');
}

export async function signOutAccount(): Promise<void> {
  if (!(await drainSync(true)))
    throw new Error('Connect and sync your swipes before signing out.');
  const result = await authClient.signOut();
  if (result.error)
    throw new Error(result.error.message ?? 'Could not sign out.');
  await clearAccountData();
  resetAuthSession();
  window.location.assign('/');
}

export async function deleteCurrentAccount(): Promise<void> {
  const response = await fetch('/api/me', {
    method: 'DELETE',
    headers: { 'X-Requested-With': 'fetch' },
  });
  if (!response.ok) throw new Error('Could not delete account.');
  await clearAccountData();
  resetAuthSession();
  window.location.assign('/');
}

export async function reconcileAccountLikes() {
  if (!(await drainSync(true)))
    throw new Error('Waiting to sync before refreshing Liked.');
  const likes: {
    id: string;
    cardId: string;
    shownAt: number;
    swipedAt: number;
    card: Card;
  }[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL('/api/me/likes', window.location.origin);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load saved likes.');
    const page = (await response.json()) as {
      likes: typeof likes;
      nextCursor: string | null;
    };
    likes.push(...page.likes);
    cursor = page.nextCursor;
  } while (cursor);
  return replaceLikedFromServer(likes);
}

/** Matches the API's per-request limit on card IDs. */
const LIKE_COUNT_BATCH = 100;

/**
 * Refresh like totals for the cards on Liked and store them locally. Signed-in
 * accounts get totals from reconcileAccountLikes instead.
 */
export async function refreshLikeCounts(): Promise<LocalSwipe[]> {
  const swipes = await getSwipes();
  const counted = countedLikeIds(swipes);
  const ids = [
    ...new Set(
      swipes
        .filter((swipe) => swipe.verdict === 1 && !swipe.removed)
        .map((swipe) => swipe.cardId),
    ),
  ];
  const counts: Record<string, number> = {};
  for (let start = 0; start < ids.length; start += LIKE_COUNT_BATCH) {
    const url = new URL('/api/like-counts', window.location.origin);
    for (const id of ids.slice(start, start + LIKE_COUNT_BATCH))
      url.searchParams.append('id', id);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not refresh like totals.');
    Object.assign(
      counts,
      ((await response.json()) as { counts: Record<string, number> }).counts,
    );
  }
  if (ids.length) await saveLikeCounts(counts, counted);
  return getSwipes();
}
