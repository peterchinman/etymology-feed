# Etymology Feed

M1 contains a read-only Cloudflare Worker API and a static Astro placeholder. The
dictionary comes from the `dictionary-2026-09-20b` release of
[`random-word-generator-site`](https://github.com/peterchinman/random-word-generator-site/releases/tag/dictionary-2026-09-20b).
The full release assets are never committed here. `apps/api/fixtures/etymology-500.sql`
contains the first 500 shuffle positions from that release for local D1 tests.
Wiktionary text is from kaikki.org and licensed CC BY-SA 4.0.

Use Node 24:

```sh
npm ci
npm run build:web
npm run typecheck:api
npm run test:api
npm run test:shared
npm run lint
```

To try the HTTP routes locally, import the fixture once and start Wrangler:

```sh
cd apps/api
npx wrangler d1 execute DICT --local --file fixtures/etymology-500.sql
npx wrangler dev
```

`GET /api/feed?n=100` returns 100 distinct wild cards. `GET /api/words/{word}`
returns one card; `GET /healthz` checks the dictionary. The feed has no
per-user served record yet; that arrives in M3.
