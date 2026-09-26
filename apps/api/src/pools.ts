import {
  betaDraw,
  betaShapeParameters,
  posteriorMean,
} from '@etymology-feed/shared/scoring';

export type Candidate = [
  word: string,
  likes: number,
  dislikes: number,
  prior: number,
];
export type Pools = {
  builtAt: number;
  wordCount: number;
  rec: Candidate[];
  unknown: string[];
};
type StatRow = { word: string; likes: number; dislikes: number; prior: number };

export async function buildPools(env: CloudflareBindings): Promise<Pools> {
  const size = Number(env.REC_POOL_SIZE);
  const unknownSize = Number(env.UNKNOWN_POOL_SIZE);
  const minRatings = Number(env.MIN_RATINGS);
  // idx_word_stats_unrated: stop after 500 rated rows, even on a large release.
  const ratedCount = await env.APP.prepare(
    'SELECT word FROM word_stats WHERE likes + dislikes >= ? LIMIT 500',
  )
    .bind(minRatings)
    .all<{ word: string }>();
  let rec: StatRow[];
  let recRowsRead = 0;
  if (ratedCount.results.length < 500) {
    // idx_word_stats_score: cold start fills the same capped pool by score.
    const cold = await env.APP.prepare(
      'SELECT word, likes, dislikes, prior FROM word_stats ORDER BY score DESC LIMIT ?',
    )
      .bind(size)
      .all<StatRow>();
    rec = cold.results;
    recRowsRead = cold.meta.rows_read;
  } else {
    // Default MIN_RATINGS=5 uses the partial recommended index.
    const rated = await env.APP.prepare(
      minRatings >= 5
        ? 'SELECT word, likes, dislikes, prior FROM word_stats WHERE likes + dislikes >= 5 AND likes + dislikes >= ? AND score >= 0.5 ORDER BY score DESC LIMIT ?'
        : 'SELECT word, likes, dislikes, prior FROM word_stats WHERE likes + dislikes >= ? AND score >= 0.5 ORDER BY score DESC LIMIT ?',
    )
      .bind(minRatings, size)
      .all<StatRow>();
    rec = rated.results;
    recRowsRead = rated.meta.rows_read;
  }
  // idx_word_stats_unrated: at most unknownSize result rows.
  const unknown = await env.APP.prepare(
    'SELECT word FROM word_stats WHERE likes + dislikes < ? ORDER BY likes + dislikes ASC, prior DESC LIMIT ?',
  )
    .bind(minRatings, unknownSize)
    .all<{ word: string }>();
  // Primary-key lookup: one row read.
  const meta = await env.DICT.prepare(
    "SELECT value FROM meta WHERE key = 'row_count'",
  ).first<{ value: string }>();
  const pools: Pools = {
    builtAt: Date.now(),
    wordCount: Number(meta?.value ?? 0),
    rec: rec.map(({ word, likes, dislikes, prior }) => [
      word,
      likes,
      dislikes,
      prior,
    ]),
    unknown: unknown.results.map(({ word }) => word),
  };
  await env.CACHE.put('pools:v1', JSON.stringify(pools));
  console.log(
    JSON.stringify({
      event: 'pools_refresh',
      rec: pools.rec.length,
      unknown: pools.unknown.length,
      rowsRead:
        ratedCount.meta.rows_read + recRowsRead + unknown.meta.rows_read,
    }),
  );
  return pools;
}

export async function getPools(env: CloudflareBindings): Promise<Pools> {
  const cached = await env.CACHE.get<Pools>('pools:v1', 'json');
  return cached ?? buildPools(env);
}

export function rankRecommended(
  rec: readonly Candidate[],
  strength: number,
): string[] {
  return rec
    .map(([word, likes, dislikes, prior]) => {
      const { alpha, beta } = betaShapeParameters(
        prior,
        likes,
        dislikes,
        strength,
      );
      return { word, draw: betaDraw(alpha, beta) };
    })
    .sort((a, b) => b.draw - a.draw)
    .map(({ word }) => word);
}

export function shuffleUnknown(
  words: readonly string[],
  random: () => number = Math.random,
): string[] {
  const shuffled = [...words.slice(0, 1000)];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function updatedScore(
  prior: number,
  likes: number,
  dislikes: number,
  strength: number,
): number {
  return posteriorMean(prior, likes, dislikes, strength);
}
