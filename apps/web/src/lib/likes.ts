import type { LocalSwipe } from './local';

/**
 * The total a Liked card shows: the stored server total, plus this user's own
 * like when that total was read before the like reached the server.
 */
export function likedTotal(
  swipe: Pick<LocalSwipe, 'card' | 'countIncludesSelf'>,
): number {
  return (swipe.card.likeCount ?? 0) + (swipe.countIncludesSelf ? 0 : 1);
}

/**
 * IDs of likes the server already had when a totals request started. Take
 * this before fetching: a like that syncs while the request is in flight is
 * marked synced, yet the total that comes back predates it.
 */
export function countedLikeIds(swipes: readonly LocalSwipe[]): Set<string> {
  return new Set(
    swipes
      .filter((swipe) => swipe.verdict === 1 && !swipe.removed && swipe.synced)
      .map((swipe) => swipe.id),
  );
}

/** A liked swipe carrying a refreshed server total. */
export function withRefreshedCount(
  swipe: LocalSwipe,
  count: number,
  counted: ReadonlySet<string>,
): LocalSwipe {
  return {
    ...swipe,
    card: { ...swipe.card, likeCount: count },
    countIncludesSelf: counted.has(swipe.id),
  };
}
