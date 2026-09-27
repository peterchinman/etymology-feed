import type { Card } from '@etymology-feed/shared/card';
import { authClient, ensureAnonymousSession, resetAuthSession } from './auth';
import { clearAccountData, replaceLikedFromServer } from './local';
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
