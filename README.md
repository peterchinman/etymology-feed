# Etymology Feed

M2 adds an offline-first Astro/Solid Feed and Liked screen to the read-only M1 API. The
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
npm run typecheck:web
npm run test:api
npm run test:shared
npm run test:e2e
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
per-user served record yet; that arrives in M3. M2 keeps the card stack, served
words, swipes, and settings in IndexedDB. It never sends swipes to the server.
The Liked screen and first 100 swipes remain usable offline after the shell and
one batch are fetched. `npm run test:e2e` starts an isolated local Wrangler D1
fixture and runs the Playwright offline checks in installed Chrome.
