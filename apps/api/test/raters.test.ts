import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getAccountLikes, mergeAnonymousAccount } from '../src/accounts';
import { getUserFeed } from '../src/feed';
import { applyRequestedFlags, TALLY } from '../src/raters';
import { deleteLiked, syncSwipes } from '../src/sync';
import { raterOf, raterWith } from './helpers';

/** Distinct fixture cards; each test takes its own slice. */
async function cards(offset: number, count: number) {
  const rows = await env.DICT.prepare(
    'SELECT id FROM word ORDER BY shuffle LIMIT ? OFFSET ?',
  )
    .bind(count, offset)
    .all<{ id: string }>();
  if (rows.results.length !== count) throw new Error('Fixture is too small.');
  return rows.results.map(({ id }) => id);
}

async function totals(ids: string[]) {
  const rows = await env.APP.prepare(
    'SELECT card_id, likes, dislikes FROM word_stats WHERE card_id IN (SELECT value FROM json_each(?))',
  )
    .bind(JSON.stringify(ids))
    .all<{ card_id: string; likes: number; dislikes: number }>();
  return new Map(
    rows.results.map((row) => [row.card_id, [row.likes, row.dislikes]]),
  );
}

async function tallies(userId: string) {
  const rows = await env.APP.prepare(
    'SELECT card_id, dealt, tally FROM swipe WHERE user_id = ?',
  )
    .bind(userId)
    .all<{ card_id: string; dealt: number; tally: number }>();
  return new Map(rows.results.map((row) => [row.card_id, row.tally]));
}

/** Rules with a hold configured; the default counts from the first swipe. */
const holding = { ...env, RATER_HOLD_SWIPES: 20 } as unknown as typeof env;

let clock = Date.now();
const swipe = (cardId: string, verdict: 1 | -1, swipedAt = ++clock) => ({
  id: crypto.randomUUID(),
  cardId,
  verdict,
  shownAt: swipedAt - 1,
  swipedAt,
});

/** Expected totals after adding verdicts to a snapshot. */
function plus(
  before: Map<string, number[]>,
  verdicts: [string, 1 | -1][],
): Map<string, number[]> {
  const after = new Map([...before].map(([id, pair]) => [id, [...pair]]));
  for (const [id, verdict] of verdicts) {
    const pair = after.get(id);
    if (!pair) throw new Error(`No statistics for ${id}.`);
    pair[verdict === 1 ? 0 : 1] += 1;
  }
  return after;
}

describe('cards the feed did not deal', () => {
  it('counts search likes but never lefts on undealt cards, and keeps them out of the like rate', async () => {
    const [dealt, searched, recovered, buried] = await cards(0, 4);
    const user = await raterWith([dealt]);
    // Cookie-loss history only prevents repeats; it does not deal cards.
    await getUserFeed(env, user, 1, [recovered], true);
    const ids = [dealt, searched, recovered, buried];
    const before = await totals(ids);
    const result = await syncSwipes(env, user, [
      swipe(dealt, 1),
      swipe(searched, 1),
      swipe(recovered, 1),
      swipe(buried, -1),
    ]);
    expect(result.results.every(({ status }) => status === 'synced')).toBe(
      true,
    );
    expect(await totals(ids)).toEqual(
      plus(before, [
        [dealt, 1],
        [searched, 1],
        [recovered, 1],
      ]),
    );
    expect(await tallies(user)).toEqual(
      new Map([
        [dealt, TALLY.counted],
        [searched, TALLY.counted],
        [recovered, TALLY.counted],
        [buried, TALLY.ignored],
      ]),
    );
    // A search like is a like by construction: only dealt cards are judged.
    expect(await raterOf(user)).toMatchObject({ rated: 1, liked: 1 });
    // Search likes reach the user's own list, and leave it cleanly.
    const likes = await getAccountLikes(env, user, 10);
    expect(likes.likes.map(({ cardId }) => cardId).sort()).toEqual(
      [dealt, searched, recovered].sort(),
    );
    expect(await deleteLiked(env, user, searched)).toBe(true);
    expect(await totals(ids)).toEqual(
      plus(before, [
        [dealt, 1],
        [recovered, 1],
      ]),
    );
  });

  it('ignores undealt likes when the setting is off', async () => {
    const [dealt, searched] = await cards(4, 2);
    const user = await raterWith([dealt]);
    const before = await totals([dealt, searched]);
    const dealtOnly = {
      ...env,
      RATER_COUNT_UNDEALT_LIKES: 0,
    } as unknown as typeof env;
    await syncSwipes(dealtOnly, user, [swipe(dealt, 1), swipe(searched, 1)]);
    expect(await totals([dealt, searched])).toEqual(plus(before, [[dealt, 1]]));
    expect(await tallies(user)).toEqual(
      new Map([
        [dealt, TALLY.counted],
        [searched, TALLY.ignored],
      ]),
    );
    // Every swipe records whether it was dealt, so past undealt likes stay
    // identifiable if the setting is turned off later.
    expect(
      await env.APP.prepare(
        'SELECT card_id FROM swipe WHERE user_id = ? AND dealt = 0',
      )
        .bind(user)
        .all<{ card_id: string }>(),
    ).toMatchObject({ results: [{ card_id: searched }] });
  });
});

describe('trust', () => {
  it('counts a new reader from their first swipe by default', async () => {
    const [id] = await cards(5, 1);
    const user = await raterWith([id], { status: 'pending' });
    const before = await totals([id]);
    await syncSwipes(env, user, [swipe(id, -1)]);
    expect(await raterOf(user)).toMatchObject({ status: 'trusted', rated: 1 });
    expect(await totals([id])).toEqual(plus(before, [[id, -1]]));
  });

  it('holds new readers when a hold is configured, then applies everything held', async () => {
    const ids = await cards(10, 20);
    const user = await raterWith(ids, { status: 'pending' });
    const before = await totals(ids);
    const verdicts = ids.map(
      (id, i) => [id, i % 4 === 0 ? 1 : -1] as [string, 1 | -1],
    );
    await syncSwipes(
      holding,
      user,
      verdicts.slice(0, 10).map(([id, verdict]) => swipe(id, verdict)),
    );
    expect(await totals(ids)).toEqual(before);
    expect(await raterOf(user)).toMatchObject({
      status: 'pending',
      rated: 10,
      liked: 3,
    });
    expect([...(await tallies(user)).values()]).toEqual(
      Array(10).fill(TALLY.held),
    );

    await syncSwipes(
      holding,
      user,
      verdicts.slice(10).map(([id, verdict]) => swipe(id, verdict)),
    );
    expect(await raterOf(user)).toMatchObject({
      status: 'trusted',
      rated: 20,
      liked: 5,
    });
    expect(await totals(ids)).toEqual(plus(before, verdicts));
    expect([...(await tallies(user)).values()]).toEqual(
      Array(20).fill(TALLY.counted),
    );
  });

  it('flags a new reader who likes everything once judged, however swipes are batched', async () => {
    const ids = await cards(30, 50);
    const before = await totals(ids);
    // All at once: judged in the same sync, so nothing ever counts.
    const batched = await raterWith(ids.slice(0, 25), { status: 'pending' });
    await syncSwipes(
      env,
      batched,
      ids.slice(0, 25).map((id) => swipe(id, 1)),
    );
    expect(await raterOf(batched)).toMatchObject({
      status: 'flagged',
      rated: 25,
      liked: 25,
    });
    // Spread out: the early likes count, then leave once there is evidence.
    const spread = ids.slice(25);
    const steady = await raterWith(spread, { status: 'pending' });
    await syncSwipes(
      env,
      steady,
      spread.slice(0, 19).map((id) => swipe(id, 1)),
    );
    expect((await raterOf(steady))?.status).toBe('trusted');
    expect(await totals(ids)).toEqual(
      plus(
        before,
        spread.slice(0, 19).map((id) => [id, 1]),
      ),
    );
    await syncSwipes(
      env,
      steady,
      spread.slice(19).map((id) => swipe(id, 1)),
    );
    expect(await raterOf(steady)).toMatchObject({
      status: 'flagged',
      rated: 25,
      liked: 25,
    });
    expect(await totals(ids)).toEqual(before);
  });

  it('keeps a rater at exactly half likes and flags one like past it', async () => {
    const ids = await cards(185, 21);
    const user = await raterWith(ids);
    const before = await totals(ids);
    const even = ids.slice(0, 20).map((id, i) => swipe(id, i % 2 ? 1 : -1));
    await syncSwipes(env, user, even);
    expect(await raterOf(user)).toMatchObject({
      status: 'trusted',
      rated: 20,
      liked: 10,
    });
    // 11 likes in 21 dealt swipes is past the 0.5 ceiling.
    await syncSwipes(env, user, [swipe(ids[20], 1)]);
    expect((await raterOf(user))?.status).toBe('flagged');
    expect(await totals(ids)).toEqual(before);
  });

  it('flags a trusted rater who turns to liking everything and removes their counts', async () => {
    const ids = await cards(60, 120);
    const user = await raterWith(ids);
    const before = await totals(ids);
    const reading = ids.slice(0, 20).map((id) => swipe(id, -1));
    await syncSwipes(env, user, reading);
    expect(await totals(ids)).toEqual(
      plus(
        before,
        ids.slice(0, 20).map((id) => [id, -1]),
      ),
    );
    // 100 likes in 120 dealt swipes passes the 0.8 ceiling.
    await syncSwipes(
      env,
      user,
      ids.slice(20).map((id) => swipe(id, 1)),
    );
    expect(await raterOf(user)).toMatchObject({
      status: 'flagged',
      rated: 120,
      liked: 100,
    });
    expect(await totals(ids)).toEqual(before);
    expect(new Set((await tallies(user)).values())).toEqual(
      new Set([TALLY.ignored]),
    );
    // Nothing a flagged rater does counts again.
    await syncSwipes(env, user, [swipe(ids[0], 1)]);
    expect(await totals(ids)).toEqual(before);
  });
});

describe('pace', () => {
  it('counts only the earliest swipes its credit covers, and never the rest', async () => {
    const ids = await cards(200, 8);
    const user = await raterWith(ids, { credit: 3 });
    const before = await totals(ids);
    // An offline backlog arrives out of order; credit goes to the earliest.
    const start = ++clock;
    clock += 100;
    const backlog = ids.map((id, i) => swipe(id, -1, start + (7 - i)));
    const result = await syncSwipes(env, user, backlog);
    expect(result.results.every(({ status }) => status === 'synced')).toBe(
      true,
    );
    const earliest = ids.slice(-3);
    expect(await totals(ids)).toEqual(
      plus(
        before,
        earliest.map((id) => [id, -1]),
      ),
    );
    const state = await tallies(user);
    for (const id of ids)
      expect(state.get(id)).toBe(
        earliest.includes(id) ? TALLY.counted : TALLY.ignored,
      );
    expect((await raterOf(user))?.credit).toBeLessThan(1);
  });

  it('earns one credit per second of server time', async () => {
    const ids = await cards(195, 12);
    // About ten and a half seconds idle: ten whole credits, well short of 11.
    const user = await raterWith(ids, {
      credit: 0,
      creditAt: Date.now() - 10_500,
    });
    await syncSwipes(
      env,
      user,
      ids.map((id) => swipe(id, -1)),
    );
    const counted = [...(await tallies(user)).values()].filter(
      (tally) => tally === TALLY.counted,
    );
    expect(counted).toHaveLength(10);
  });

  it('gives a brand-new guest credit only for time since it was created', async () => {
    const ids = await cards(210, 2);
    const created = Date.now();
    const user = await raterWith(ids, { credit: 0, createdAt: created });
    // Rebuild the rater the way first use does: credit accrues from creation.
    await env.APP.prepare('DELETE FROM rater WHERE user_id = ?')
      .bind(user)
      .run();
    const before = await totals(ids);
    // A slow pace keeps a slow test machine from earning a credit mid-test.
    const hourly = {
      ...env,
      RATER_PACE_SECONDS: 3600,
    } as unknown as typeof env;
    await syncSwipes(
      hourly,
      user,
      ids.map((id) => swipe(id, -1)),
    );
    expect(await totals(ids)).toEqual(before);
    expect(await raterOf(user)).toMatchObject({ status: 'trusted', rated: 2 });
    // Ignored for lack of credit: nothing will ever apply these.
    expect([...(await tallies(user)).values()]).toEqual([
      TALLY.ignored,
      TALLY.ignored,
    ]);
  });

  it('spends credit once when two syncs race', async () => {
    const [first, second] = await cards(220, 2);
    const user = await raterWith([first, second], { credit: 1 });
    const before = await totals([first, second]);
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = {
      prepare: env.APP.prepare.bind(env.APP),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await env.APP.batch(statements);
        // Both requests read the same credit before either writes.
        if (reads < 2) {
          if (++reads === 2) release();
          await bothRead;
        }
        return results;
      },
    } as D1Database;
    const racing = { ...env, APP: app };
    await Promise.all([
      syncSwipes(racing, user, [swipe(first, -1)]),
      syncSwipes(racing, user, [swipe(second, -1)]),
    ]);
    const after = await totals([first, second]);
    const added = [first, second].reduce(
      (sum, id) => sum + (after.get(id)?.[1] ?? 0) - (before.get(id)?.[1] ?? 0),
      0,
    );
    expect(added).toBe(1);
    expect((await tallies(user)).size).toBe(2);
  });
});

describe('merging and undoing', () => {
  it('applies a guest’s held swipes when it signs in to a trusted account', async () => {
    const ids = await cards(240, 3);
    const guest = await raterWith(ids, { status: 'pending' });
    const member = await raterWith([], { anonymous: false });
    const before = await totals(ids);
    await syncSwipes(
      holding,
      guest,
      ids.map((id) => swipe(id, -1)),
    );
    expect(await totals(ids)).toEqual(before);
    await mergeAnonymousAccount(env, guest, member);
    expect(await totals(ids)).toEqual(
      plus(
        before,
        ids.map((id) => [id, -1]),
      ),
    );
    expect(await raterOf(member)).toMatchObject({
      status: 'trusted',
      rated: 3,
      liked: 0,
    });
    // Cards dealt to the guest stay swipeable as counted cards afterwards.
    const later = await syncSwipes(env, member, [swipe(ids[0], 1)]);
    expect(later.results[0].status).toBe('synced');
    expect(await totals(ids)).toEqual(
      plus(before, [
        [ids[1], -1],
        [ids[2], -1],
        [ids[0], 1],
      ]),
    );
  });

  it('judges two held histories together under the current hold', async () => {
    const ids = await cards(245, 2);
    const guest = await raterWith(ids, { status: 'pending' });
    const member = await raterWith([], {
      anonymous: false,
      status: 'pending',
    });
    const before = await totals(ids);
    await syncSwipes(
      holding,
      guest,
      ids.map((id) => swipe(id, -1)),
    );
    expect(await totals(ids)).toEqual(before);
    // Neither side was trusted, but the default hold of zero is already met.
    await mergeAnonymousAccount(env, guest, member);
    expect((await raterOf(member))?.status).toBe('trusted');
    expect(await totals(ids)).toEqual(
      plus(
        before,
        ids.map((id) => [id, -1]),
      ),
    );
  });

  it('carries a flag across sign-in and removes the account’s counts', async () => {
    const ids = await cards(250, 2);
    const guest = await raterWith([ids[0]]);
    const member = await raterWith([ids[1]], { anonymous: false });
    const before = await totals(ids);
    await syncSwipes(env, member, [swipe(ids[1], 1)]);
    await syncSwipes(env, guest, [swipe(ids[0], 1)]);
    expect(await totals(ids)).toEqual(
      plus(
        before,
        ids.map((id) => [id, 1]),
      ),
    );
    await env.APP.prepare(
      "UPDATE rater SET status = 'flagged' WHERE user_id = ?",
    )
      .bind(guest)
      .run();
    await mergeAnonymousAccount(env, guest, member);
    expect((await raterOf(member))?.status).toBe('flagged');
    // The guest's counted like moved with it, and both are gone now.
    expect(await totals(ids)).toEqual(before);
  });

  it('applies a manual flag from the cron, once', async () => {
    const ids = await cards(260, 4);
    const user = await raterWith(ids);
    const before = await totals(ids);
    await syncSwipes(
      env,
      user,
      ids.map((id, i) => swipe(id, i ? -1 : 1)),
    );
    expect(await totals(ids)).not.toEqual(before);
    await env.APP.prepare(
      "UPDATE rater SET status = 'flagging' WHERE user_id = ?",
    )
      .bind(user)
      .run();
    const plan = await env.APP.prepare(
      "EXPLAIN QUERY PLAN SELECT user_id FROM rater WHERE status = 'flagging' LIMIT 50",
    ).all<{ detail: string }>();
    expect(
      plan.results.some(({ detail }) => detail.includes('idx_rater_flagging')),
    ).toBe(true);
    expect(await applyRequestedFlags(env)).toBeGreaterThanOrEqual(1);
    expect((await raterOf(user))?.status).toBe('flagged');
    expect(await totals(ids)).toEqual(before);
    await applyRequestedFlags(env);
    expect(await totals(ids)).toEqual(before);
  });

  it('keeps guests from deleting themselves, which would orphan their counts', async () => {
    const signIn = await SELF.fetch('http://localhost/auth/sign-in/anonymous', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost',
      },
      body: '{}',
    });
    expect(signIn.status).toBe(200);
    const { user } = (await signIn.json()) as { user: { id: string } };
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? '';
    const removal = await SELF.fetch(
      'http://localhost/auth/delete-anonymous-user',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          Cookie: cookie,
        },
        body: '{}',
      },
    );
    expect(removal.ok).toBe(false);
    expect(
      await env.APP.prepare('SELECT id FROM user WHERE id = ?')
        .bind(user.id)
        .first(),
    ).not.toBeNull();
  });
});
