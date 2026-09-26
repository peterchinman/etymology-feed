import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { FeedUnavailable, getWildFeed, getWord } from './feed';

const app = new Hono<{ Bindings: CloudflareBindings }>();

const feedQuery = z.object({
  n: z.coerce.number().int().min(1).max(100).default(100),
});

const routes = app
  .get('/healthz', async (c) => {
    // Primary-key lookup on meta.key: 1 row read, 0 written.
    const row = await c.env.DICT.prepare(
      "SELECT value FROM meta WHERE key = 'row_count'",
    ).first<{ value: string }>();
    if (!row) throw new FeedUnavailable('The dictionary is not loaded.');
    return c.json({ status: 'ok', dictWords: Number(row.value) });
  })
  .get(
    '/api/feed',
    zValidator('query', feedQuery, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'invalid_query',
              message: 'n must be an integer from 1 to 100.',
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      const { n } = c.req.valid('query');
      const { cards, rowsRead } = await getWildFeed({ dict: c.env.DICT }, n);
      console.log(
        JSON.stringify({ event: 'feed_fetch', cards: cards.length, rowsRead }),
      );
      return c.json({ cards });
    },
  )
  .get('/api/words/:word', async (c) => {
    const card = await getWord({ dict: c.env.DICT }, c.req.param('word'));
    if (!card) {
      return c.json(
        { error: { code: 'word_not_found', message: 'Word not found.' } },
        404,
      );
    }
    c.header('Cache-Control', 'public, max-age=86400');
    return c.json(card);
  });

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404),
);
app.onError((error, c) => {
  if (error instanceof FeedUnavailable) {
    return c.json(
      { error: { code: 'dictionary_unavailable', message: error.message } },
      503,
    );
  }
  console.error(error);
  return c.json(
    { error: { code: 'internal_error', message: 'Internal server error.' } },
    500,
  );
});

export type AppType = typeof routes;
export default app;
