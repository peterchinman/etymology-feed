import type { Card } from '@etymology-feed/shared/card';
import { describe, expect, it } from 'vitest';
import { countedLikeIds, likedTotal, withRefreshedCount } from './likes';
import type { LocalSwipe } from './local';

const card = (likeCount?: number) => ({ likeCount }) as Card;

describe('likedTotal', () => {
  it('adds the user to a total read before their like reached the server', () => {
    expect(likedTotal({ card: card(0) })).toBe(1);
    expect(likedTotal({ card: card(41), countIncludesSelf: false })).toBe(42);
  });

  it('counts a cached card without a total as the user alone', () => {
    expect(likedTotal({ card: card() })).toBe(1);
  });

  it('uses a refreshed total that already includes the user as is', () => {
    expect(likedTotal({ card: card(42), countIncludesSelf: true })).toBe(42);
  });
});

describe('refreshed totals', () => {
  const like = (id: string, synced: boolean): LocalSwipe => ({
    id,
    cardId: `card-${id}`,
    word: 'bluff',
    verdict: 1,
    bucket: undefined,
    shownAt: 0,
    swipedAt: 0,
    synced,
    card: card(0),
  });

  it('counts the user only for likes the server had before the request', () => {
    const before = [like('old', true), like('new', false)];
    const counted = countedLikeIds(before);
    // "new" syncs while the totals request is in flight; its total predates it.
    const after = before.map((swipe) => ({ ...swipe, synced: true }));
    const [old, fresh] = after.map((swipe) =>
      withRefreshedCount(swipe, 3, counted),
    );
    expect(likedTotal(old)).toBe(3);
    expect(likedTotal(fresh)).toBe(4);
  });

  it('ignores removed likes and dislikes', () => {
    const removed = { ...like('removed', true), removed: true };
    const disliked = { ...like('disliked', true), verdict: -1 as const };
    expect(countedLikeIds([removed, disliked]).size).toBe(0);
  });
});
