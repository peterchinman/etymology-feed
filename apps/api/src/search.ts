export const WORD_SEARCH_SQL = `
  SELECT DISTINCT word FROM word
  WHERE word LIKE ? ESCAPE '\\'
  ORDER BY word COLLATE NOCASE, word LIMIT 13
`;

export async function searchWords(dict: D1Database, query: string) {
  // idx_word_search bounds the prefix range; stop after 13 distinct headwords.
  // Escape LIKE wildcards so punctuation is searched literally. No writes.
  const prefix = `${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await dict.prepare(WORD_SEARCH_SQL).bind(prefix).all<{
    word: string;
  }>();
  return {
    words: rows.results.slice(0, 12).map(({ word }) => word),
    hasMore: rows.results.length > 12,
  };
}
