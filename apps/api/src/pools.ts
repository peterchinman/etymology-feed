import { betaDraw, betaShapeParameters } from '@etymology-feed/shared/scoring';

export type Candidate = [cardId: string, likes: number, dislikes: number];
/**
 * Lanes by information state (§6.1). `confirmed` and `promising` carry their
 * counts so the feed can Thompson-sample them; `fresh` is already ordered by
 * looks then the heuristic prior. Parked cards (never liked in five looks, or
 * liked but below average after fifteen) are reachable only through wild.
 */
export type Pools = {
  builtAt: number;
  cardCount: number;
  confirmed: Candidate[];
  promising: Candidate[];
  fresh: string[];
};
type StatRow = { card_id: string; likes: number; dislikes: number };

export const POOLS_KEY = 'pools:v3';

export async function buildPools(
  env: CloudflareBindings,
): Promise<Pools & { rowsRead: number }> {
  const confirmedSize = Number(env.CONFIRMED_POOL_SIZE);
  const promisingSize = Number(env.PROMISING_POOL_SIZE);
  const freshSize = Number(env.FRESH_POOL_SIZE);
  const minRatings = Number(env.MIN_RATINGS);
  const confirmScore = Number(env.CONFIRM_SCORE);
  const parkLooks = Number(env.PARK_LOOKS);
  // idx_word_stats_rec (partial, n >= 5 AND score >= 0.5): reads only rows at
  // or above average, at most confirmedSize. The literals let SQLite prove the
  // partial index applies; the bound CONFIRM_SCORE (>= 0.5) then narrows to
  // clearly-above-average. A MIN_RATINGS below 5 falls back to a scan and
  // needs new cost measurements.
  const confirmed = await env.APP.prepare(
    minRatings >= 5
      ? 'SELECT card_id, likes, dislikes FROM word_stats WHERE likes + dislikes >= 5 AND likes + dislikes >= ? AND score >= 0.5 AND score >= ? ORDER BY score DESC LIMIT ?'
      : 'SELECT card_id, likes, dislikes FROM word_stats WHERE likes + dislikes >= ? AND score >= 0.5 AND score >= ? ORDER BY score DESC LIMIT ?',
  )
    .bind(minRatings, confirmScore, confirmedSize)
    .all<StatRow>();
  // idx_word_stats_promising (partial): liked cards that are neither confirmed
  // (n >= 5 AND score >= 0.55) nor parked (n >= 15 AND score < 0.5). Reads only
  // the lane's own rows, at most promisingSize. The index predicate hardcodes
  // the default thresholds; other values fall back to a scan that needs new
  // cost measurements (§6.1).
  const defaultThresholds =
    minRatings === 5 && confirmScore === 0.55 && parkLooks === 15;
  const promising = await env.APP.prepare(
    defaultThresholds
      ? 'SELECT card_id, likes, dislikes FROM word_stats WHERE likes > 0 AND (likes + dislikes < 5 OR score < 0.55) AND (likes + dislikes < 15 OR score >= 0.5) ORDER BY score DESC LIMIT ?'
      : 'SELECT card_id, likes, dislikes FROM word_stats WHERE likes > 0 AND (likes + dislikes < ? OR score < ?) AND (likes + dislikes < ? OR score >= 0.5) ORDER BY score DESC LIMIT ?',
  )
    .bind(
      ...(defaultThresholds
        ? [promisingSize]
        : [minRatings, confirmScore, parkLooks, promisingSize]),
    )
    .all<StatRow>();
  if (!defaultThresholds)
    console.warn(
      'Non-default MIN_RATINGS/CONFIRM_SCORE/PARK_LOOKS: promising lane scans instead of using idx_word_stats_promising.',
    );
  // idx_word_stats_unrated ((likes + dislikes), prior DESC): never-liked cards,
  // fewest looks first, best prior first. Never-seen cards fill the lane until
  // the frontier is exhausted; only then do cards passed over once get a second
  // look. Reads freshSize rows plus any liked low-n rows the index range skips.
  const fresh = await env.APP.prepare(
    'SELECT card_id FROM word_stats WHERE likes = 0 AND likes + dislikes < ? ORDER BY likes + dislikes ASC, prior DESC LIMIT ?',
  )
    .bind(minRatings, freshSize)
    .all<{ card_id: string }>();
  // Primary-key lookup: one row read.
  const meta = await env.DICT.prepare(
    "SELECT value FROM meta WHERE key = 'row_count'",
  ).first<{ value: string }>();
  const toCandidates = (rows: StatRow[]): Candidate[] =>
    rows.map(({ card_id, likes, dislikes }) => [card_id, likes, dislikes]);
  const pools: Pools = {
    builtAt: Date.now(),
    cardCount: Number(meta?.value ?? 0),
    confirmed: toCandidates(confirmed.results),
    promising: toCandidates(promising.results),
    fresh: fresh.results.map(({ card_id }) => card_id),
  };
  await env.CACHE.put(POOLS_KEY, JSON.stringify(pools));
  const rowsRead =
    confirmed.meta.rows_read + promising.meta.rows_read + fresh.meta.rows_read;
  console.log(
    JSON.stringify({
      event: 'pools_refresh',
      confirmed: pools.confirmed.length,
      promising: pools.promising.length,
      fresh: pools.fresh.length,
      rowsRead,
    }),
  );
  return { ...pools, rowsRead };
}

export async function getPools(env: CloudflareBindings): Promise<Pools> {
  const cached = await env.CACHE.get<Pools>(POOLS_KEY, 'json');
  return cached ?? buildPools(env);
}

/** Thompson sampling over a rated lane with weighted lefts (§6.2). */
export function rankLane(
  candidates: readonly Candidate[],
  dislikeWeight: number,
  random: () => number = Math.random,
): string[] {
  return candidates
    .map(([cardId, likes, dislikes]) => {
      const { alpha, beta } = betaShapeParameters(
        likes,
        dislikes,
        dislikeWeight,
      );
      return { cardId, draw: betaDraw(alpha, beta, random) };
    })
    .sort((a, b) => b.draw - a.draw)
    .map(({ cardId }) => cardId);
}

/** Jitters the head of the fresh lane so concurrent users do not all get the same card. */
export function shuffleFresh(
  cardIds: readonly string[],
  random: () => number = Math.random,
): string[] {
  const shuffled = [...cardIds.slice(0, 1000)];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
