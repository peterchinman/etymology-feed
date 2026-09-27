import type { Card } from '@etymology-feed/shared/card';
import {
  type Bucket,
  interleave,
  pickFromLanes,
  slotPattern,
} from '@etymology-feed/shared/scoring';
import { getPools, rankLane, shuffleFresh } from './pools';

type WordRow = {
  id: string;
  word: string;
  etym_no: number | null;
  ipa: string | null;
  tier: string;
  shape: string;
  pos: string;
  definition: string;
  def_pos: string;
  etymology: string;
  etym_band: string;
  shuffle: number;
};

type Bindings = { dict: D1Database };

const CARD_COLUMNS =
  'id, word, etym_no, ipa, tier, shape, pos, definition, def_pos, etymology, etym_band, shuffle';

export class FeedUnavailable extends Error {}

export function toCard(row: WordRow, bucket?: Card['bucket']): Card {
  return {
    id: row.id,
    word: row.word,
    etymNo: row.etym_no,
    ipa: row.ipa,
    pos: JSON.parse(row.pos) as string[],
    definition: row.definition,
    defPos: row.def_pos,
    etymology: row.etymology,
    tier: row.tier,
    shape: row.shape,
    etymBand: row.etym_band,
    ...(bucket ? { bucket } : {}),
  };
}

export function randomPosition(maximum: number): number {
  const random = new Uint32Array(1);
  const range = 0x1_0000_0000;
  const acceptedBelow = range - (range % maximum);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= acceptedBelow);
  return (random[0] % maximum) + 1;
}

const SERVED_KEY = 'SELECT card_ids FROM served WHERE user_id = ?';

export async function getUserFeed(
  env: CloudflareBindings,
  userId: string,
  count: number,
  known: string[] = [],
): Promise<{ cards: Card[]; rowsRead: number; rowsWritten: number }> {
  const pools = await getPools(env);
  if (pools.cardCount < count)
    throw new FeedUnavailable(
      'The dictionary is not ready for this batch size.',
    );
  const cap = Number(env.SERVED_CAP);
  const pattern = slotPattern({
    confirmed: Number(env.CONFIRMED_SLOTS),
    promising: Number(env.PROMISING_SLOTS),
    fresh: Number(env.FRESH_SLOTS),
    wild: Number(env.WILD_SLOTS),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    // served.user_id PK: one row read.
    const record = await env.APP.prepare(SERVED_KEY)
      .bind(userId)
      .all<{ card_ids: string }>();
    const oldWords = record.results[0]?.card_ids;
    const previous: string[] = oldWords ? JSON.parse(oldWords) : [];
    const previousSet = new Set(previous);
    for (const id of known)
      if (!previousSet.has(id)) {
        previousSet.add(id);
        previous.push(id);
      }
    if (previous.length > cap) previous.splice(0, previous.length - cap);
    const seen = new Set(previous);
    const positions = new Set<number>();
    const wild = new Map<string, WordRow>();
    const wildNeeded = interleave(count, pattern).filter(
      (bucket) => bucket === 'wild',
    ).length;
    let rowsRead = record.meta.rows_read;
    // Draw wild positions first; the remaining pools then skip these words.
    for (let i = 0; i < wildNeeded; i++) {
      let found = false;
      for (let tries = 0; tries < Math.min(pools.cardCount, 1000); tries++) {
        const position = randomPosition(pools.cardCount);
        if (positions.has(position)) continue;
        positions.add(position);
        // idx_word_shuffle equality: one row read.
        const query = await env.DICT.prepare(
          `SELECT ${CARD_COLUMNS} FROM word WHERE shuffle = ?`,
        )
          .bind(position)
          .all<WordRow>();
        rowsRead += query.meta.rows_read;
        const row = query.results[0];
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        wild.set(row.id, row);
        found = true;
        break;
      }
      if (!found) break;
    }
    const dislikeWeight = Number(env.DISLIKE_WEIGHT);
    const lanes = {
      confirmed: rankLane(pools.confirmed, dislikeWeight),
      promising: rankLane(pools.promising, dislikeWeight),
      fresh: shuffleFresh(pools.fresh),
    };
    const slots = interleave(count, pattern);
    const chosen: { id: string; bucket: Bucket }[] = [];
    let wildIndex = 0;
    const wildIds = [...wild.keys()];
    for (const slot of slots) {
      if (slot === 'wild' && wildIndex < wildIds.length) {
        chosen.push({ id: wildIds[wildIndex++], bucket: 'wild' });
        continue;
      }
      // Fill-through: an empty lane hands its slot down (§6.4). The recorded
      // bucket is the lane the card came from, so per-lane like-rates are honest.
      const picked = pickFromLanes(slot, lanes, seen);
      if (picked) chosen.push({ id: picked.item, bucket: picked.lane });
    }
    // Pool exhaustion relaxes to wild, drawing until the requested count is reached.
    while (chosen.length < count && seen.size < pools.cardCount) {
      const position = randomPosition(pools.cardCount);
      if (positions.has(position)) continue;
      positions.add(position);
      const query = await env.DICT.prepare(
        `SELECT ${CARD_COLUMNS} FROM word WHERE shuffle = ?`,
      )
        .bind(position)
        .all<WordRow>();
      rowsRead += query.meta.rows_read;
      const row = query.results[0];
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      wild.set(row.id, row);
      chosen.push({ id: row.id, bucket: 'wild' });
    }
    // Individual primary-key lookups cost one row each in D1, whereas the
    // JSON-array IN query measured three rows per card on the fixture.
    const lookups = chosen.filter(({ id }) => !wild.has(id));
    const fetched = lookups.length
      ? await env.DICT.batch(
          lookups.map(({ id }) =>
            env.DICT.prepare(
              `SELECT ${CARD_COLUMNS} FROM word WHERE id = ?`,
            ).bind(id),
          ),
        )
      : [];
    const byWord = new Map<string, WordRow>(wild);
    fetched.forEach((result) => {
      rowsRead += result.meta.rows_read;
      for (const row of result.results as WordRow[]) byWord.set(row.id, row);
    });
    const cards = chosen
      .map(({ id, bucket }) => {
        const row = byWord.get(id);
        return row ? toCard(row, bucket) : undefined;
      })
      .filter((card): card is Card => !!card);
    const nextWords = JSON.stringify(
      [...previous, ...cards.map(({ id }) => id)].slice(-cap),
    );
    const now = Date.now();
    // CAS on the JSON value prevents concurrent fetches from losing updates.
    const write =
      oldWords === undefined
        ? await env.APP.prepare(
            'INSERT INTO served (user_id, card_ids, count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          )
            .bind(userId, nextWords, JSON.parse(nextWords).length, now)
            .run()
        : await env.APP.prepare(
            'UPDATE served SET card_ids = ?, count = ?, updated_at = ? WHERE user_id = ? AND card_ids = ?',
          )
            .bind(
              nextWords,
              JSON.parse(nextWords).length,
              now,
              userId,
              oldWords,
            )
            .run();
    if (write.meta.changes === 1)
      return { cards, rowsRead, rowsWritten: write.meta.rows_written };
  }
  throw new FeedUnavailable('Concurrent feed requests need a retry.');
}

/** M1's read-only uniform feed. M3 adds served tracking and scored pools. */
export async function getWildFeed(
  { dict }: Bindings,
  count: number,
  startOverride?: number,
): Promise<{
  cards: Card[];
  rowsRead: number;
}> {
  // Primary-key lookup on meta.key: 1 row read, 0 written.
  const meta = await dict
    .prepare("SELECT value FROM meta WHERE key = 'row_count'")
    .all<{ value: string }>();
  const maximum = Number(meta.results[0]?.value);
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < count ||
    maximum > 0x1_0000_0000
  ) {
    throw new FeedUnavailable(
      'The dictionary is not ready for this batch size.',
    );
  }

  // A uniformly random start in the release's permutation gives every word
  // exactly count/maximum inclusion probability. LIMIT keeps D1 at one row read
  // per card; the JSON-array IN form measured 3 rows read per card in D1.
  const start = startOverride ?? randomPosition(maximum);
  if (!Number.isSafeInteger(start) || start < 1 || start > maximum) {
    throw new RangeError('Invalid shuffle start.');
  }
  const firstCount = Math.min(count, maximum - start + 1);
  // idx_word_shuffle range scan: firstCount rows read, 0 written.
  const first = await dict
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM word WHERE shuffle >= ? ORDER BY shuffle LIMIT ?`,
    )
    .bind(start, firstCount)
    .all<WordRow>();
  const wrapCount = count - firstCount;
  // idx_word_shuffle range scan: wrapCount rows read, 0 written; only needed at the end of the permutation.
  const wrapped =
    wrapCount > 0
      ? await dict
          .prepare(
            `SELECT ${CARD_COLUMNS} FROM word WHERE shuffle < ? ORDER BY shuffle LIMIT ?`,
          )
          .bind(start, wrapCount)
          .all<WordRow>()
      : null;
  const rows = [...first.results, ...(wrapped?.results ?? [])];
  if (rows.length !== count) {
    throw new FeedUnavailable('The dictionary shuffle index is incomplete.');
  }
  return {
    cards: rows.map((row) => toCard(row, 'wild')),
    rowsRead:
      meta.meta.rows_read +
      first.meta.rows_read +
      (wrapped?.meta.rows_read ?? 0),
  };
}

export async function getWord(
  { dict }: Bindings,
  id: string,
): Promise<Card | null> {
  // Primary-key lookup on word.id: 1 row read, 0 written.
  const row = await dict
    .prepare(`SELECT ${CARD_COLUMNS} FROM word WHERE id = ?`)
    .bind(id)
    .first<WordRow>();
  return row ? toCard(row) : null;
}

export async function getWordEtymologies(
  { dict }: Bindings,
  word: string,
): Promise<Card[]> {
  const rows = await dict
    .prepare(`SELECT ${CARD_COLUMNS} FROM word WHERE word = ? ORDER BY etym_no`)
    .bind(word)
    .all<WordRow>();
  return rows.results.map((row) => toCard(row));
}
