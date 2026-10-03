import { env, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { searchWords, WORD_SEARCH_SQL } from '../src/search';

it('finds headwords without a session, ignores ASCII case, and groups origins', async () => {
  const response = await SELF.fetch('http://localhost/api/search?q=%20BLUF%20');
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.json()).toEqual({ words: ['bluff'], hasMore: false });
  expect((await searchWords(env.DICT, 'ravencl')).words).toContain('Ravenclaw');
  expect((await searchWords(env.DICT, 'béarnaise ')).words).toEqual([
    'béarnaise sauce',
  ]);
  expect((await searchWords(env.DICT, 'Tamp')).words).toContain('Tampere');
});

it('validates queries, escapes wildcards, and bounds suggestions', async () => {
  for (const query of ['', '   ', 'x'.repeat(201)]) {
    const response = await SELF.fetch(
      `http://localhost/api/search?${new URLSearchParams({ q: query })}`,
    );
    expect(response.status).toBe(400);
  }
  for (const query of ['%', '_', '\\', "' OR 1=1 --", 'zzzznotaword']) {
    expect(await searchWords(env.DICT, query)).toEqual({
      words: [],
      hasMore: false,
    });
  }
  const results = await searchWords(env.DICT, 'a');
  expect(results.words).toHaveLength(12);
  expect(results.hasMore).toBe(true);
  expect(new Set(results.words).size).toBe(12);
});

it('uses the search index to read only a prefix range', async () => {
  const plan = await env.DICT.prepare(`EXPLAIN QUERY PLAN ${WORD_SEARCH_SQL}`)
    .bind('bl%')
    .all<{ detail: string }>();
  expect(
    plan.results.some(({ detail }) =>
      detail.includes('SEARCH word USING COVERING INDEX idx_word_search'),
    ),
  ).toBe(true);
  expect(plan.results.some(({ detail }) => detail.includes('SCAN word'))).toBe(
    false,
  );
  const matches = await env.DICT.prepare(WORD_SEARCH_SQL).bind('bl%').all();
  expect(matches.meta.rows_read).toBeLessThan(30);
});
