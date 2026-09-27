import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { createAuth } from './auth';
import { FeedUnavailable, getUserFeed, getWord } from './feed';
import { buildPools } from './pools';
import { deleteLiked, syncInput, syncSwipes } from './sync';

type Variables = { userId: string; isAnonymous: boolean };
const app = new Hono<{ Bindings: CloudflareBindings; Variables: Variables }>();
const feedQuery = z.object({
  n: z.coerce.number().int().min(1).max(100).default(100),
  known: z.string().optional(),
});

app.all('/auth/*', (c) =>
  createAuth(c.env, new URL(c.req.url).origin).handler(c.req.raw),
);
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/words/')) return next();
  if (
    ['POST', 'DELETE'].includes(c.req.method) &&
    c.req.header('X-Requested-With') !== 'fetch'
  )
    return c.json(
      { error: { code: 'csrf', message: 'Missing X-Requested-With header.' } },
      403,
    );
  const auth = createAuth(c.env, new URL(c.req.url).origin);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  let currentUser = session?.user;
  if (!currentUser) {
    const created = await auth.api.signInAnonymous({
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const cookie = created.headers.get('set-cookie');
    if (cookie) c.header('Set-Cookie', cookie);
    const body = (await created.json()) as {
      user?: { id: string; isAnonymous?: boolean };
    };
    if (!body.user)
      return c.json(
        {
          error: {
            code: 'auth_unavailable',
            message: 'Could not start an anonymous session.',
          },
        },
        503,
      );
    currentUser = body.user as NonNullable<typeof currentUser>;
  }
  c.set('userId', currentUser.id);
  c.set('isAnonymous', !!currentUser.isAnonymous);
  await next();
});

const routes = app
  .get('/healthz', async (c) => {
    // PK probes: DICT 1 row; APP 0-1 row; KV one read.
    const [dict] = await Promise.all([
      c.env.DICT.prepare(
        "SELECT value FROM meta WHERE key = 'row_count'",
      ).first<{ value: string }>(),
      c.env.APP.prepare('SELECT id FROM user WHERE id = ?')
        .bind('__health__')
        .first(),
      c.env.CACHE.get('pools:v1'),
    ]);
    if (!dict) throw new FeedUnavailable('The dictionary is not loaded.');
    return c.json({ status: 'ok', dictWords: Number(dict.value) });
  })
  .get(
    '/api/feed',
    zValidator('query', feedQuery, (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'invalid_query',
              message: 'n must be an integer from 1 to 100.',
            },
          },
          400,
        );
    }),
    async (c) => {
      if (!(await c.env.FEED_RATE.limit({ key: c.get('userId') })).success)
        return c.json(
          { error: { code: 'rate_limited', message: 'Try again shortly.' } },
          429,
        );
      const { n, known } = c.req.valid('query');
      let seed: string[] = [];
      if (known) {
        try {
          const value = JSON.parse(known);
          if (
            !Array.isArray(value) ||
            value.length > 30_000 ||
            !value.every((word) => typeof word === 'string')
          )
            throw Error();
          seed = value;
        } catch {
          return c.json(
            {
              error: {
                code: 'invalid_query',
                message: 'known must be a JSON array of at most 30,000 words.',
              },
            },
            400,
          );
        }
      }
      const result = await getUserFeed(c.env, c.get('userId'), n, seed);
      console.log(
        JSON.stringify({
          event: 'feed_fetch',
          cards: result.cards.length,
          rowsRead: result.rowsRead,
          rowsWritten: result.rowsWritten,
        }),
      );
      return c.json({ cards: result.cards });
    },
  )
  .post('/api/sync', zValidator('json', syncInput), async (c) => {
    if (!(await c.env.SYNC_RATE.limit({ key: c.get('userId') })).success)
      return c.json(
        { error: { code: 'rate_limited', message: 'Try again shortly.' } },
        429,
      );
    return c.json(
      await syncSwipes(c.env, c.get('userId'), c.req.valid('json').swipes),
    );
  })
  .delete('/api/swipes/:word', async (c) =>
    c.json({
      removed: await deleteLiked(c.env, c.get('userId'), c.req.param('word')),
    }),
  )
  .get('/api/me', (c) =>
    c.json({
      user: {
        id: c.get('userId'),
        isAnonymous: c.get('isAnonymous'),
        name: null,
        image: null,
      },
      providers: [] as string[],
    }),
  )
  .get('/api/words/:word', async (c) => {
    const card = await getWord({ dict: c.env.DICT }, c.req.param('word'));
    if (!card)
      return c.json(
        { error: { code: 'word_not_found', message: 'Word not found.' } },
        404,
      );
    c.header('Cache-Control', 'public, max-age=86400');
    return c.json(card);
  });

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404),
);
app.onError((error, c) => {
  if (error instanceof FeedUnavailable)
    return c.json(
      { error: { code: 'dictionary_unavailable', message: error.message } },
      503,
    );
  console.error(error);
  return c.json(
    { error: { code: 'internal_error', message: 'Internal server error.' } },
    500,
  );
});

export type AppType = typeof routes;
export default {
  fetch: app.fetch,
  scheduled(
    controller: ScheduledController,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) {
    if (controller.cron === '*/5 * * * *') ctx.waitUntil(buildPools(env));
  },
};
