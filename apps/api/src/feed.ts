import type { Card } from '@etymology-feed/shared/card';

type WordRow = {
  word: string;
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
  'word, ipa, tier, shape, pos, definition, def_pos, etymology, etym_band, shuffle';

export class FeedUnavailable extends Error {}

function toCard(row: WordRow, bucket?: Card['bucket']): Card {
  return {
    word: row.word,
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

function randomPosition(maximum: number): number {
  const random = new Uint32Array(1);
  const range = 0x1_0000_0000;
  const acceptedBelow = range - (range % maximum);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= acceptedBelow);
  return (random[0] % maximum) + 1;
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
  word: string,
): Promise<Card | null> {
  // Primary-key lookup on word.word: 1 row read, 0 written.
  const row = await dict
    .prepare(`SELECT ${CARD_COLUMNS} FROM word WHERE word = ?`)
    .bind(word)
    .first<WordRow>();
  return row ? toCard(row) : null;
}
