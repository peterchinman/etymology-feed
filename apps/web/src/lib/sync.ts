import { ensureAnonymousSession } from './auth';
import {
  confirmRemoval,
  getPendingRemovals,
  getUnsyncedSwipes,
  markSwipesSynced,
} from './local';

let draining: Promise<void> | undefined;
let retryAt = 0;
let failures = 0;

export function drainSync(): Promise<void> {
  if (!navigator.onLine || Date.now() < retryAt) return Promise.resolve();
  draining ??= (async () => {
    await ensureAnonymousSession();
    for (;;) {
      const pending = await getUnsyncedSwipes();
      if (!pending.length) break;
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'fetch',
        },
        body: JSON.stringify({
          swipes: pending.map(
            ({ id, cardId, verdict, bucket, shownAt, swipedAt }) => ({
              id,
              cardId,
              verdict,
              bucket,
              shownAt,
              swipedAt,
            }),
          ),
        }),
      });
      if (!response.ok) throw new Error(`Sync returned ${response.status}.`);
      const result = (await response.json()) as {
        results: { id: string; status: string }[];
      };
      const done = result.results
        .filter(({ status }) => status === 'synced' || status === 'duplicate')
        .map(({ id }) => id);
      await markSwipesSynced(done);
      if (!done.length || pending.length < 500) break;
    }
    for (const swipe of await getPendingRemovals()) {
      const response = await fetch(
        `/api/swipes/${encodeURIComponent(swipe.cardId)}`,
        { method: 'DELETE', headers: { 'X-Requested-With': 'fetch' } },
      );
      if (!response.ok) throw new Error(`Remove returned ${response.status}.`);
      await confirmRemoval(swipe.id);
    }
    failures = 0;
    retryAt = 0;
  })()
    .catch(() => {
      failures++;
      retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** failures);
    })
    .finally(() => {
      draining = undefined;
    });
  return draining;
}
