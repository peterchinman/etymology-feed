import { type Card, isFeedEligible } from '@etymology-feed/shared/card';
import {
  type Bucket,
  interleave,
  pickFromLanes,
  slotPattern,
} from '@etymology-feed/shared/scoring';
import { withLikeCounts } from './likes';
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

function eligibleRow(row: WordRow, includeProperNouns: boolean): boolean {
  return isFeedEligible({ defPos: row.def_pos }, includeProperNouns);
}

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

/** Resolve a bounded page of liked cards without one D1 parameter per ID. */
export async function getCardsByIds(
  dict: D1Database,
  ids: string[],
): Promise<Map<string, Card>> {
  if (!ids.length) return new Map();
  const rows = await dict
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM word WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<WordRow>();
  return new Map(rows.results.map((row) => [row.id, toCard(row)]));
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
  includeProperNouns = false,
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
        if (!row || !eligibleRow(row, includeProperNouns) || seen.has(row.id))
          continue;
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
    const selected: (Card | undefined)[] = Array.from({ length: count });
    let wildIndex = 0;
    const wildRows = [...wild.values()];
    slots.forEach((slot, index) => {
      if (slot === 'wild' && wildIndex < wildRows.length)
        selected[index] = toCard(wildRows[wildIndex++], 'wild');
    });

    // Retry a filtered/missing candidate in its original slot before using
    // random recovery. Seen tracks attempted IDs too, so no ID is fetched twice.
    // At most 500 indexed candidate lookups per attempt; ordinary complete
    // batches still resolve each chosen card exactly once.
    const rankedLimit = 500;
    let rankedLookups = 0;
    while (selected.some((card) => !card) && rankedLookups < rankedLimit) {
      const candidates: { index: number; id: string; bucket: Bucket }[] = [];
      for (const [index, slot] of slots.entries()) {
        if (rankedLookups + candidates.length >= rankedLimit) break;
        if (selected[index]) continue;
        const picked = pickFromLanes(slot, lanes, seen);
        if (!picked) continue;
        candidates.push({ index, id: picked.item, bucket: picked.lane });
      }
      if (!candidates.length) break;
      // Individual PK lookups cost one row per existing card, unlike JSON IN.
      const results = await env.DICT.batch(
        candidates.map(({ id }) =>
          env.DICT.prepare(
            `SELECT ${CARD_COLUMNS} FROM word WHERE id = ?`,
          ).bind(id),
        ),
      );
      rankedLookups += candidates.length;
      results.forEach((result, index) => {
        rowsRead += result.meta.rows_read;
        const row = result.results[0] as WordRow | undefined;
        if (row && eligibleRow(row, includeProperNouns)) {
          const candidate = candidates[index];
          selected[candidate.index] = toCard(row, candidate.bucket);
        }
      });
    }
    const cards = selected.filter((card): card is Card => !!card);
    // APP statistics outlive a DICT switch or rollback. Resolve the selected
    // IDs before filling through: missing or ineligible cards cannot consume slots.
    // Historical IDs can also be absent from this DICT, so seen.size is not a
    // count of unavailable dictionary rows. Only an actual scan proves that.
    const delivered = new Set([...previous, ...cards.map(({ id }) => id)]);
    const scanLimit = Math.min(pools.cardCount, 1000);
    let scanned = 0;
    let cursor = cards.length < count ? randomPosition(pools.cardCount) : 1;
    while (cards.length < count && scanned < scanLimit) {
      const size = Math.min(
        100,
        scanLimit - scanned,
        pools.cardCount - cursor + 1,
      );
      // idx_word_shuffle range: at most size rows read, no writes. This bounded
      // recovery runs on lane exhaustion or the ranked candidate lookup limit.
      const query = await env.DICT.prepare(
        `SELECT ${CARD_COLUMNS} FROM word WHERE shuffle >= ? ORDER BY shuffle LIMIT ?`,
      )
        .bind(cursor, size)
        .all<WordRow>();
      rowsRead += query.meta.rows_read;
      for (const row of query.results) {
        if (!eligibleRow(row, includeProperNouns) || delivered.has(row.id))
          continue;
        delivered.add(row.id);
        cards.push(toCard(row, 'wild'));
        if (cards.length === count) break;
      }
      scanned += size;
      cursor = ((cursor - 1 + size) % pools.cardCount) + 1;
    }
    if (cards.length < count && scanned < pools.cardCount) {
      // Do not report exhaustion to the offline client just because this
      // request reached its recovery budget. No served history is written.
      throw new FeedUnavailable('Feed recovery needs a retry.');
    }
    const counted = await withLikeCounts(env.APP, cards);
    rowsRead += counted.rowsRead;
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
      return {
        cards: counted.cards,
        rowsRead,
        rowsWritten: write.meta.rows_written,
      };
  }
  throw new FeedUnavailable('Concurrent feed requests need a retry.');
}

/** M1's read-only uniform feed. M3 adds served tracking and scored pools. */
export async function getWildFeed(
  { dict }: Bindings,
  count: number,
  startOverride?: number,
  includeProperNouns = false,
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

  const start = startOverride ?? randomPosition(maximum);
  if (!Number.isSafeInteger(start) || start < 1 || start > maximum) {
    throw new RangeError('Invalid shuffle start.');
  }
  const cards: Card[] = [];
  let rowsRead = meta.meta.rows_read;
  let scanned = 0;
  let cursor = start;
  const limit = Math.min(maximum, 1000);
  while (cards.length < count && scanned < limit) {
    const size = Math.min(
      count - cards.length,
      maximum - cursor + 1,
      limit - scanned,
    );
    const page = await dict
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM word WHERE shuffle >= ? ORDER BY shuffle LIMIT ?`,
      )
      .bind(cursor, size)
      .all<WordRow>();
    rowsRead += page.meta.rows_read;
    for (const row of page.results)
      if (eligibleRow(row, includeProperNouns)) cards.push(toCard(row, 'wild'));
    scanned += size;
    cursor = ((cursor - 1 + size) % maximum) + 1;
  }
  if (cards.length !== count)
    throw new FeedUnavailable(
      'Not enough eligible cards within the feed scan budget.',
    );
  return { cards, rowsRead };
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
