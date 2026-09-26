import { getPools } from './pools';

type Counter = { likes: number; total: number };
type Groups = Record<string, Counter>;
type Daily = {
  date: string;
  total: Counter;
  bucket: Groups;
  etymBand: Groups;
  shape: Groups;
  tier: Groups;
  hasSignal: Groups;
};
type SwipeRow = {
  user_id: string;
  word: string;
  verdict: number;
  bucket: string | null;
  received_at: number;
};
type MetaRow = {
  word: string;
  etym_band: string;
  shape: string;
  tier: string;
  has_signal: number;
};

function add(group: Groups, key: string, liked: boolean) {
  group[key] ??= { likes: 0, total: 0 };
  const count = group[key];
  count.total++;
  if (liked) count.likes++;
}
function empty(date: string): Daily {
  return {
    date,
    total: { likes: 0, total: 0 },
    bucket: {},
    etymBand: {},
    shape: {},
    tier: {},
    hasSignal: {},
  };
}
function merge(days: Daily[]): Omit<Daily, 'date'> {
  const result = empty('');
  for (const day of days) {
    result.total.likes += day.total.likes;
    result.total.total += day.total.total;
    for (const dimension of [
      'bucket',
      'etymBand',
      'shape',
      'tier',
      'hasSignal',
    ] as const) {
      for (const [key, counter] of Object.entries(day[dimension])) {
        result[dimension][key] ??= { likes: 0, total: 0 };
        const target = result[dimension][key];
        target.likes += counter.likes;
        target.total += counter.total;
      }
    }
  }
  return result;
}
function rates(group: Groups) {
  return Object.fromEntries(
    Object.entries(group).map(([key, value]) => [
      key,
      { ...value, likeRate: value.total ? value.likes / value.total : 0 },
    ]),
  );
}

export async function buildNightlyStats(
  env: CloudflareBindings,
  now = new Date(),
) {
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const start = end - 30 * 86_400_000;
  const days = Array.from({ length: 30 }, (_, i) =>
    empty(new Date(end - (i + 1) * 86_400_000).toISOString().slice(0, 10)),
  );
  const byDate = new Map(days.map((day) => [day.date, day]));
  let cursorUser = '';
  let cursorWord = '';
  for (;;) {
    // Nightly exception: scan the 30-day window in composite-PK order to bound memory.
    const page = await env.APP.prepare(
      'SELECT user_id,word,verdict,bucket,received_at FROM swipe WHERE (user_id,word)>(?,?) AND received_at>=? AND received_at<? ORDER BY user_id,word LIMIT 100',
    )
      .bind(cursorUser, cursorWord, start, end)
      .all<SwipeRow>();
    if (!page.results.length) break;
    const last = page.results[page.results.length - 1];
    cursorUser = last.user_id;
    cursorWord = last.word;
    // word.word PK: at most one DICT row per swipe. No cross-D1 join is available.
    const meta = await env.DICT.batch(
      page.results.map((row) =>
        env.DICT.prepare(
          'SELECT word,etym_band,shape,tier,has_signal FROM word WHERE word=?',
        ).bind(row.word),
      ),
    );
    page.results.forEach((row, i) => {
      const word = meta[i].results[0] as MetaRow | undefined;
      if (!word) return;
      const day = byDate.get(
        new Date(row.received_at).toISOString().slice(0, 10),
      );
      if (!day) return;
      const liked = row.verdict === 1;
      day.total.total++;
      if (liked) day.total.likes++;
      add(day.bucket, row.bucket ?? 'unknown', liked);
      add(day.etymBand, word.etym_band, liked);
      for (const shape of word.shape.split(',')) add(day.shape, shape, liked);
      add(day.tier, word.tier, liked);
      add(day.hasSignal, String(word.has_signal), liked);
    });
  }
  const seven = merge(days.slice(0, 7));
  const thirty = merge(days);
  // Expression index idx_word_stats_unrated: one scalar row returned.
  const rated = await env.APP.prepare(
    'SELECT COUNT(*) AS count FROM word_stats WHERE likes + dislikes >= ?',
  )
    .bind(Number(env.MIN_RATINGS))
    .first<{ count: number }>();
  const pools = await getPools(env);
  const format = (group: Omit<Daily, 'date'>) => ({
    ...group,
    globalLikeRate: group.total.total
      ? group.total.likes / group.total.total
      : 0,
    bucket: rates(group.bucket),
    etymBand: rates(group.etymBand),
    shape: rates(group.shape),
    tier: rates(group.tier),
    hasSignal: rates(group.hasSignal),
  });
  const report = {
    builtAt: Date.now(),
    globalLikeRate: thirty.total.total
      ? thirty.total.likes / thirty.total.total
      : 0,
    periods: { 7: format(seven), 30: format(thirty) },
    ratedWords: rated?.count ?? 0,
    pools: {
      builtAt: pools.builtAt,
      rec: pools.rec.length,
      unknown: pools.unknown.length,
    },
    swipesPerDay: days.map((day) => ({
      date: day.date,
      count: day.total.total,
    })),
  };
  await env.CACHE.put('stats:v1', JSON.stringify(report));
  console.log(
    JSON.stringify({
      event: 'stats_refresh',
      date: days[0].date,
      swipes: days[0].total.total,
      globalLikeRate: report.globalLikeRate,
    }),
  );
  return report;
}
