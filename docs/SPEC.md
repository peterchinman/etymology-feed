# Etymology Feed — Project Spec & Coding-Agent Handoff

Working name: **Etymology Feed** (rename freely; nothing below depends on it).
Author: Peter Chinman. Drafted 2026-09-25; revision 3 (all-TypeScript on Cloudflare, offline-first, data-backed dictionary selection). Status: **ready for implementation.**

---

## 0. Handoff prompt (paste this to the coding agent)

> You are implementing the project described in `docs/SPEC.md`. Read the whole spec before writing code. Work milestone by milestone (§10), in order, and stop at the end of each milestone for review. Each milestone has acceptance criteria; do not mark it done until they pass. Follow the conventions in §11. Where the spec says "decide" or "open", pick the recommended option and note the choice in `docs/DECISIONS.md`. Do not add dependencies, services, or features that the spec does not call for without asking. Everything runs on Cloudflare's free plan; treat the free-plan limits in §3.4 as hard budgets and note in the PR any query whose rows-read cost you could not keep small. The dictionary source is the GitHub release named in `database/RELEASE` of `github.com/peterchinman/random-word-generator-site`; never vendor it into git. Selection thresholds in §4 were chosen from measurements in §2; do not change them without new measurements, and instrument them as §6.5 requires so they can be revisited with data.

---

## 1. What we're building

A mobile-first, **offline-first** web app that shows one English word per card with its etymology. Swipe right = "interesting", swipe left = "not interesting". A second screen lists the words the user swiped right on. Swipes from everyone are aggregated so the feed can (a) surface etymologies other people found interesting and (b) gather ratings for words nobody has rated yet. Accounts are optional (OAuth); without one, the liked list lives on the device. With no signal, the app keeps working from a locally stored stack of cards and syncs when it can.

Two screens, one Worker, one dictionary. Keep it that small.

---

## 2. Findings about the data (this shapes everything else)

Source: `dictionary.db` from the Random Word Generator (RWG) repo, built from the kaikki.org Wiktionary extract. Profiled release `dictionary-2026-09-20b` (883,995 words; 474,427 have ≥1 etymology; all etymology text is 27 MB).

### 2.1 Length is the wrong filter; "morphology vs. story" is the right one

The original baseline measured each word's longest etymology and classified it with a regex as **morphology** (only says how the word is assembled from English parts: "From clergy + -man."), **pointer** ("Clipping of…", "Alternative form of…"), or **story** (everything else). The following bands are historical word-level measurements; the local multi-etymology rebuild selected 155,032 cards across 148,180 headwords:

| Length band | Words | Morphology | Pointer | Story | Story count |
|---|---|---|---|---|---|
| < 40 chars | 330,470 | 78.8% | 3.8% | 17.4% | 57,627 |
| 40–60 | 41,580 | 5.2% | 4.0% | 90.8% | 37,763 |
| 60–80 | 28,249 | 2.2% | 3.3% | 94.5% | 26,689 |
| 80–120 | 29,141 | 1.2% | 0.1% | 98.7% | 28,763 |
| 120–200 | 23,901 | 0.5% | 0.0% | 99.5% | 23,777 |
| 200+ | 21,086 | 0.0% | 0.0% | 100% | 21,079 |

A flat "≥ 80 chars" cutoff discards ~64k stories between 40 and 80 chars ("Named after Moniteau Creek, from a French spelling of manitou.", "From Latin iūcundus. Doublet of jocund.") while keeping ~500 long morphology entries. Stories under 40 chars are mostly thin ("Borrowed from Irish Ceatharlach.") but not worthless.

A second signal: whether the text names a source language/period (Latin, Old Norse, Proto-Germanic, Teochew…) or contains a quoted gloss (“…”). Among stories, 60–90% carry that signal in every band; the ones without are typically place-name trivia or weak morphology the regex missed.

### 2.2 Word shape does not predict etymology quality

Counts of words with an etymology ≥ 80 chars, by shape flag: multiword **13,628** (idioms: *fall on one's sword*, *double whammy*), capitalized **22,409** (given names, surnames, places: *Altair*, *Kaleb*, *Luttrell*), hyphenated 2,845, apostrophe 1,284, non-ASCII 571, digits 261 (*7-Eleven*, *40k*), pointer-only 2,925 (*higher criticism*, calque of German *höhere Kritik*). These are genres, not junk. All are included; the shape is recorded per word so it can be filtered or measured.

### 2.3 Consequences

1. **Selection is by each etymology text, not the word** (§4.1). The published one-card release has 147,954 cards; the rebuilt preview has **155,032 cards**.
2. The rebuilt dictionary export is 47 MB of SQL; fine for D1 (5 GB free).
3. **A headword is not a card ID.** User data keys on a distinct card ID for each retained etymology. The source build preserves the entry-to-etymology link so each card receives a matching definition.
4. Wiktionary text is **CC BY-SA 4.0**: credit Wiktionary/kaikki.org and link the license (footer + a "source" line on each card).
5. Whether short stories and each shape genre actually earn their place is a **post-launch, data question**: §6.5 reports like-rate by length band and by shape so the thresholds in §4.1 can be revisited with evidence.

---

## 3. Architecture

### 3.1 One Cloudflare Worker, all TypeScript

```
Browser (offline-capable PWA) ──► Worker (Hono)
   IndexedDB: card stack,           ├─ /api/*, /auth/*  → handlers
   liked list, swipe queue,         ├─ everything else  → Workers Static Assets (Astro's dist/)
   served set                       ├─ D1  "DICT"       read-only dictionary (replaced per release)
                                    ├─ D1  "APP"        users, sessions, swipes, served, word_stats
                                    ├─ KV  "CACHE"      feed pools (one key), refreshed by a Cron Trigger
                                    └─ Rate Limiting binding
```

| Concern | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (single Worker, `wrangler`) | Free plan covers this app's traffic; no servers, backups or restore drills to own. |
| HTTP framework | **Hono** | Conventional Workers framework; `hc<AppType>()` RPC client gives the frontend end-to-end types with no codegen. |
| Static site | Astro (static output) via **Workers Static Assets** (`run_worker_first: ["/api/*", "/auth/*"]`) | One deploy, same origin, cookies just work. No Astro Cloudflare adapter needed. |
| UI islands | **Solid** (`@astrojs/solid-js`) | Interactive deck and liked list; Peter knows it. |
| Offline | Service worker (Workbox `generateSW` via `vite-plugin-pwa` or a hand-written 60-line SW) precaching the app shell; **all data lives in IndexedDB** (`idb`) | Feed and Liked work with no network; the SW only needs to serve the shell. |
| DB access | **Drizzle ORM** (`drizzle-orm/d1`) + `drizzle-kit` migrations | Typed schema, plain SQL underneath (rows-read cost stays visible). |
| Auth | **Better Auth** (Drizzle adapter, `anonymous` plugin, Google + GitHub social providers) | Handles OAuth/PKCE/sessions/CSRF; the anonymous plugin *is* the "device before sign-in" model in §7. |
| Feed pool cache | Workers **KV** + **Cron Trigger** (every 5 min) | Workers have no resident memory between requests; one KV read per feed request. |
| Rate limiting | Workers Rate Limiting binding | Free, no code. |
| Validation | `zod` via `@hono/zod-validator` | Request schemas double as docs. |
| Tests | `vitest` + `@cloudflare/vitest-pool-workers`; Playwright e2e (incl. offline mode via `context.setOffline`) | Runs against real D1/KV emulation. |
| Package layout | npm workspaces: `apps/api`, `apps/web`, `packages/shared` | Shared card types + pure scoring/interleave functions, tested once. |

Versions to pin at project start (check `npm view` on day one): astro 7.x, @astrojs/solid-js 7.x, solid-js 1.9.x, hono 4.x, better-auth 1.7.x, drizzle-orm 0.4x, wrangler 4.x.

### 3.2 Two D1 databases, one Worker

- **`DICT`** — read-only, 155,032 rows in the rebuilt preview (47 MB SQL). Rebuilt per dictionary release: the release script creates a *new* D1 database `dict-<tag>`, imports `etymology.sql`, updates `database_id` in `wrangler.toml`, deploys, then deletes the old one. Swapping the id makes a release atomic.
- **`APP`** — read/write. Better Auth tables, `swipe`, `served`, `word_stats`. Migrations via `drizzle-kit generate` + `wrangler d1 migrations apply`. Backups: D1 Time Travel (check retention on the free plan) plus a weekly `wrangler d1 export` to R2 from CI.

### 3.3 "Should RWG be able to read from it?"

1. **Share the data artifact.** The derive script (§4) lives in the RWG repo's `database/` and publishes `etymology.sql`, `etymology.db` and a report as additional assets on the same GitHub release as `dictionary.db`. Both sites pin `database/RELEASE`.
2. **Optionally share the runtime (Milestone 6).** Port `get_words.php` to a Hono route backed by a third D1 holding the full dictionary (430 MB; the ~3M-row import needs the $5 Workers Paid plan). RWG's frontend then calls the Worker and the droplet's PHP retires.

### 3.4 Cost and free-plan budgets (hard limits for the agent)

| Resource | Free plan | This app's cost per action | Headroom |
|---|---|---|---|
| Worker requests | 100k / day | 1 per feed fetch (100 cards), 1 per sync (≤ 500 swipes) | very large |
| Worker CPU | 10 ms / request | Thompson sampling over ≤ 3k candidates ≈ 1–2 ms; 100-card fetch ≈ 3 ms | fine |
| D1 rows read | 5M / day | feed ≈ 1 (served blob) + 100 (cards); sync ≈ 2 per swipe; pool cron ≤ 3,000 + the rated lanes' populations per run (288 runs/day ≈ 0.9M at launch, ≤ 2.6M with every lane full) | ~40k feed fetches/day |
| D1 rows written | **100k / day** ← binding limit | feed = 1 (served blob); 100 new swipes = 650 rows written including index updates | **at most ~15k swipes/day** before auth, cron, and feed writes |
| KV reads | 100k / day | 1 per feed fetch | fine |
| KV writes | 1k / day | cron every 5 min = 288 | fine |

At roughly 2,000 daily active users making eight swipes each, the D1 write cap bites; the fix is Workers Paid at **$5/month** (50M writes/month). Until then **$0/month**. The 650-row cost is measured on a 100-swipe batch with 50 likes and 50 dislikes, and includes index maintenance; actual daily headroom is lower after auth, cron, and feed writes. Design rules: every D1 query hits an index; no `ORDER BY random()`, no table scans in hot paths; D1 allows only **100 bound parameters** per statement, so `IN (…)` lists are passed as one JSON-array parameter and expanded with `json_each(?)` (the same trick `get_words.php` uses).

---

## 4. Data pipeline: deriving the dictionary

Add `database/derive_etymology.py` to the RWG repo (stdlib only, like `build.py`). Input `dictionary.db`; outputs `etymology.db` (local dev / inspection), `etymology.sql` (D1 import: `CREATE TABLE` + multi-row `INSERT`s, ≤ 100 rows per statement), and `etymology-report.txt`. Publish all three on the release tag.

### 4.1 Selection rule (from §2.1; thresholds are script arguments and are recorded in `meta`)

For each source word, classify **every distinct etymology section** separately. Retain the source entry number on both etymologies and meanings, then pair each retained etymology with the meanings in its source entries. Choose the first non-demoted definition within those entries. Keep the previous primary card ID equal to its headword for existing swipe and served data; assign each additional card a deterministic ID from its headword, etymology number, and text. Classify each `text`:

- `morph`: matches the morphology regex — an optional lead-in ("From", "Equivalent to", "Formed from/as"), then two or more parts joined by ` + `, where a part is a word/affix, a quoted string, or a word followed by a parenthesized gloss, ending with optional punctuation or "See X." **The agent must extend the regex to handle multi-word parts** ("From di- + keto acid") and verify against the 25-sample check below.
- `pointer`: starts with one of *Clipping, Abbreviation, Initialism, Acronym, Shortening, Short for, Alteration, Alternative form, Variant, Diminutive, Plural, Back-formation, Blend, Contraction, Ellipsis, Pronunciation spelling, Eye dialect, Misspelling, Compound, Univerbation, Hypocoristic, Reduplication, Doublet* and is under 70 chars.
- `story`: everything else.

`signal` = mentions a source language or period (a list of ~150 names in the script: Latin, Ancient Greek, Old English, Middle English, Old Norse, Old French, Proto-*, Sanskrit, Arabic, Hebrew, Teochew, Nahuatl, …) **or** contains a quoted gloss (`“…”` or `"…"`).

**Keep** if `class == story AND (len >= 80 OR signal)` and a paired definition exists. The full local rebuild selected **155,032 cards across 148,180 headwords**. No filter on tier or word shape.

Keep words of every tier (common … unattested) and every shape. Record the shape so the card and the analytics can use it.

### 4.2 Schema (`DICT`)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- source release tag, build time, thresholds, classifier version, row count, tier & shape histograms

CREATE TABLE word (
  id          TEXT PRIMARY KEY,   -- distinct card ID used by APP
  word        TEXT NOT NULL,      -- display headword; may occur on several cards
  etym_no     INTEGER,            -- Wiktionary etymology section, when supplied
  ipa         TEXT,
  tier        TEXT NOT NULL,      -- common | uncommon | scarce | rare | obscure | marginal | unattested
  zipf        REAL,
  shape       TEXT NOT NULL,      -- 'plain' or comma list of: multiword,capitalized,hyphenated,apostrophe,nonascii,digits,pointer_only
  pos         TEXT NOT NULL,      -- JSON array of display names
  definition  TEXT NOT NULL,      -- first non-demoted definition (revealed on tap, §9.1)
  def_pos     TEXT NOT NULL,
  etymology   TEXT NOT NULL,
  etym_len    INTEGER NOT NULL,
  etym_band   TEXT NOT NULL,      -- 'lt40' | '40_80' | '80_120' | '120_200' | '200plus'  (for analytics)
  has_signal  INTEGER NOT NULL,   -- language/gloss signal, §4.1
  prior       REAL NOT NULL,      -- 0..1 cold-start interest prior, §4.3
  shuffle     INTEGER NOT NULL    -- random permutation 1..N for cheap uniform sampling
);
CREATE UNIQUE INDEX idx_word_shuffle ON word(shuffle);
CREATE INDEX idx_word_prior ON word(prior DESC);
CREATE INDEX idx_word_headword ON word(word,etym_no);
```

`shuffle` lets "k uniformly random words" be `WHERE shuffle IN (SELECT value FROM json_each(?))` with k random integers in `1..N` — k rows read, no scan.

### 4.3 Cold-start prior

A heuristic in `[0.2, 0.8]` so unrated cards are explored best-first. **It orders the fresh lane only (§6.1); it does not enter the score.** Rated cards are judged by their ratings under a flat prior (§6.2). The heuristic was originally also the score's pseudo-count prior with `K = 5`; the release measured 16,352 of 147,954 cards clamped at 0.8, so under that design a single like on a 0.7 card still trailed 18,981 unrated cards. From `text`:
- length: < 40 → −0.1; 40–80 → 0; 80–120 → +0.1; 120–250 → +0.2; 250+ → +0.25
- each distinct language/period name: +0.05, cap +0.2
- each of "doublet", "cognate", "folk etymology", "originally", "literally", "borrow", "named after", "coined": +0.04, cap +0.15
- tier common/uncommon: +0.05; marginal/unattested: −0.05
- clamp to `[0.2, 0.8]`

The heuristic no longer needs re-centering, because only its order matters. What does track the global like-rate is `DISLIKE_WEIGHT` (§6.2): once §6.5 reports the real rate `p`, set the var to `p / (1 - p)` (or lower) and rescore the rated rows with one indexed `UPDATE … WHERE likes + dislikes > 0`. Unrated rows keep a stale score harmlessly; no lane reads it.

The report prints 20 random words from the top decile and 20 from the bottom decile, plus 25 random `morph`-classified and 25 random `story`-under-40 entries, so the classifier and the prior can be eyeballed. Tune once, then leave it; real ratings take over.

### 4.4 Verification

`derive_etymology.py --check` opens `etymology.db`, runs `PRAGMA integrity_check`, asserts row count within 100k–250k, asserts every `word` exists in `dictionary.db`, prints 10 random cards as they would render. Worker CI imports a 500-word fixture and asserts count.

---

## 5. Application database (`APP`)

Drizzle schema in `apps/api/src/db/schema.ts`; migrations in `apps/api/drizzle/`. Timestamps are INTEGER unix ms.

**Better Auth tables** (`user`, `session`, `account`, `verification`) are generated by `npx @better-auth/cli generate` into the same Drizzle schema. The `anonymous` plugin adds `user.isAnonymous`. Never hand-edit those tables.

**App tables:**

```sql
CREATE TABLE swipe (
  id          TEXT PRIMARY KEY,        -- client uuid = idempotency key
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL,
  verdict     INTEGER NOT NULL CHECK (verdict IN (1, -1)),
  bucket      TEXT,                     -- 'confirmed' | 'promising' | 'fresh' | 'wild': the lane the card came from (§6.1)
  shown_at    INTEGER NOT NULL,         -- client clock: when the card was actually displayed
  swiped_at   INTEGER NOT NULL,         -- client clock
  received_at INTEGER NOT NULL,         -- server clock
  UNIQUE (user_id, card_id)
);
CREATE INDEX idx_swipe_user_liked ON swipe(user_id, swiped_at DESC) WHERE verdict = 1;

CREATE TABLE served (                   -- every card ever sent to this user: the no-repeats record
  user_id     TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  card_ids    TEXT NOT NULL,            -- JSON array of card IDs, oldest first, capped at 30,000
  count       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE word_stats (               -- denormalized aggregate, upserted on every swipe
  card_id     TEXT PRIMARY KEY,
  likes       INTEGER NOT NULL DEFAULT 0,
  dislikes    INTEGER NOT NULL DEFAULT 0,
  prior       REAL NOT NULL,            -- heuristic prior copied from DICT at seed time; orders the fresh lane only
  score       REAL NOT NULL,            -- flat-prior posterior mean, §6.2; BASE_RATE while unrated
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_word_stats_unrated ON word_stats((likes + dislikes), prior DESC);           -- fresh lane
CREATE INDEX idx_word_stats_rec ON word_stats(score DESC)
  WHERE likes + dislikes >= 5 AND score >= 0.5;                                              -- confirmed lane (partial)
CREATE INDEX idx_word_stats_promising ON word_stats(score DESC)
  WHERE likes > 0 AND likes + dislikes < 5;                                                  -- promising lane (partial)
```

The two partial indexes cost writes only for rows that qualify, so at launch they are nearly free; the general score index was dropped because no lane needs a full-table order.

Notes:
- **`served` is one row per user, not one per card.** With offline prefetching of 100 cards at a time, a per-card impressions table would cost 100 D1 writes per fetch; a JSON blob costs 1 read + 1 write. 30k entries ≈ 400 KB, under D1's 2 MB row limit. Past the cap the oldest entries roll off and a very small chance of a repeat is accepted (documented in `/about/`).
- Anonymous visitors are real `user` rows (`isAnonymous = 1`), so `user_id` is always present.
- A re-swipe of the same card by the same user **updates** the verdict (UPSERT on `(user_id, card_id)`) and adjusts `word_stats` by the delta. The `(user_id, card_id)` unique index serves this lookup and user-ordered pagination; the partial index serves Liked.
- `word_stats` is seeded from `DICT` by the release script (155,032 rows in the rebuilt preview; run on the paid plan or spread over multiple days on free), inserting only missing rows.
- There is no per-card "times served" counter (it would cost a write per card). Lane membership uses ratings, and fresh-lane order uses the prior (§6.1).

---

## 6. Feed algorithm

Goal: keep people swiping (show good stuff) while spreading ratings across the pool (show unknown stuff), never repeat a card for a user, and make the mix measurable so it can be tuned. The regime is many cards and few users (~148k cards; a like is the scarce signal), so the design routes a single like to other users within one pool refresh and treats a dislike as cheap to act on.

### 6.1 Lanes by information state

`n = likes + dislikes` for a card. Every card is in exactly one lane, and only the first three are queried as pools:

- **Confirmed**: `n >= 5 AND score >= CONFIRM_SCORE` (0.55: clearly above the average card, §6.2), top 3,000 by `score`. Empty for months; that is fine.
- **Promising**: `likes > 0 AND n < 5`, top 3,000 by `score`. **No dislike test**: a like buys a card its five looks, and Thompson ranking inside the lane already shows it less as lefts arrive. This is the lane that makes early users' likes visible.
- **Fresh**: `n = 0`, ordered by the heuristic `prior DESC` (§4.3), first 3,000. The frontier sweeps the dictionary best-first as cards receive their first rating.
- **Parked**: everything else that has been seen: lefts and no likes, or five looks that finished below `CONFIRM_SCORE`. Not pooled; reachable only through wild. With 148k cards, being wrong about a parked card is cheap, and the fresh lane's budget is not spent re-showing cards that got one left.
- **Wild**: any card, uniform via `shuffle`.

There is no minimum-rating gate on being shown, and no cold-start branch: the lanes are shares, not gates, so nothing disappears when a count crosses a threshold.

### 6.2 Scoring (pure functions in `packages/shared/scoring.ts`, unit-tested)

A left swipe is the default action in a swipe feed, so it is weak evidence: sometimes active dislike, often just "next". Each left therefore counts as `w = DISLIKE_WEIGHT` of a negative, under a flat `Beta(1, 1)` prior on that weighted scale:

```
score = (likes + 1) / (likes + w * dislikes + 2)
theta ~ Beta(likes + 1, w * dislikes + 1)          -- Thompson draw
```

The weight is not a fudge: `likes >= w * dislikes` is exactly `like-rate >= p` when `w = p / (1 - p)`, so weighting lefts by the odds of the base like-rate makes `score = 0.5` mean "the average card". The default 0.25 assumes a 20% like-rate; §6.5 prints the weight implied by the observed rate, and setting it lower still says that many lefts are boredom rather than dislike. `w = 1` recovers "a left is a dislike"; `w = 0` says a left carries no information. Looks (`n = likes + dislikes`) stay unweighted, because a left still proves the card was seen.

At `w = 0.25`: one like is 2/3, one left is 0.44, one like then two lefts is 0.57 and still promising, one like in five looks is exactly 0.5 (average, parked under the 0.55 margin), two likes in five looks is 0.64 (confirmed). Both shape parameters stay ≥ 1 for every count, which keeps Thompson sampling well-behaved. Stored in `word_stats.score`, recomputed on each swipe; unrated rows hold 0.5, which no lane reads. The heuristic prior never enters the score. For **ranking within `confirmed` and `promising`** use **Thompson sampling**: draw `theta ~ Beta(likes + alpha0, dislikes + beta0)` per candidate and take the top draws (Beta via two Marsaglia–Tsang Gamma draws, no dependency). This gives variety across users and mildly favors under-sampled winners.

### 6.3 Pools live in KV, refreshed by cron

Cron Trigger `*/5 * * * *` runs three indexed queries, one per pooled lane, each reading only that lane's own rows (≤ 3,000 for `fresh`; the partial indexes make `confirmed` and `promising` cost exactly their populations), and writes one KV key `pools:v3` = `{ builtAt, cardCount, confirmed: [[cardId, likes, dislikes]…], promising: [[cardId, likes, dislikes]…], fresh: [cardId…] }`. The feed handler reads that one key, samples in memory, then touches D1 twice. A vote therefore changes other users' feeds within about five minutes. If the read budget ever binds, a fifteen-minute cron is the lever.

### 6.4 Composing a fetch

`GET /api/feed?n=100` (n ≤ 100; the client asks for large batches because it works offline, §7.4):

1. Read `served.card_ids` for the user (1 row).
2. Fill slots per 20-card block with **6 confirmed / 6 promising / 6 fresh / 2 wild**, spread evenly by largest remainder, repeated `n/20` times. `confirmed`, `promising`: top Thompson draws; `fresh`: random from the first 1,000 of the lane (jitter so concurrent users don't all get the same card); `wild`: uniform via `shuffle`. Skip anything in `served`. **Fill-through**: a slot whose lane is exhausted takes from the lanes below it, then the lanes above, so an empty confirmed lane hands its slots to promising, then fresh; when every lane is exhausted, relax to `wild`. The card's `bucket` records the lane it actually came from, not the slot, so per-lane like-rates in §6.5 are honest.
3. Fetch the cards from `DICT` by primary-key `id` lookups (n rows read).
4. Append the n card IDs to `served.card_ids`, trim to 30,000, write back (1 write).

All tunable via `wrangler.toml` vars: `CONFIRMED_SLOTS`, `PROMISING_SLOTS`, `FRESH_SLOTS`, `WILD_SLOTS`, `MIN_RATINGS`, `DISLIKE_WEIGHT`, `CONFIRM_SCORE`, `SERVED_CAP`, `*_POOL_SIZE`. The partial indexes assume `MIN_RATINGS = 5`; another value still works but scans and needs new cost measurements.

### 6.5 Measure it — this is how the §4.1 thresholds get revisited

Every swipe carries `bucket`, and the pinned `DICT` release gives `etym_band`, `shape`, `tier`, `has_signal`. Run `apps/api/scripts/report_stats.py` locally on demand using data-only D1 exports of APP's `swipe` and `word_stats` tables and the release's `etymology.db` (never vendored). It reports like-rates for the last 7 and 30 UTC calendar days, including the current partial day: global, by lane (`bucket`), **by `etym_band`**, **by `shape`**, by tier, and by `has_signal`; the count of cards with `n >= 5` and each lane's population (confirmed, promising, fresh, parked); and current swipe rows by day. The script joins the two datasets in local SQLite. There is no nightly stats cron, KV snapshot, or admin stats endpoint. The table stores one current verdict per user and word, so this report cannot reconstruct earlier verdicts or deleted likes; `received_at` places offline swipes on the sync day. Export and local scan costs are incurred only when a report is requested.

Decision rules to apply once there are ≥ 2,000 swipes per band: if `lt40` like-rate is below half of `80_120`, raise the length floor for un-signalled stories; if a shape's like-rate is below half the plain rate, add it as a default-off filter rather than removing it. Also report the global like-rate and the `DISLIKE_WEIGHT` it implies, `p / (1 - p)`, so the weight can be re-centered on it (§4.3, §6.2). Record the outcome in `docs/DECISIONS.md`.

---

## 7. Accounts, anonymous users, offline, and sync

### 7.1 Anonymous by default (Better Auth `anonymous` plugin)

- On first API call the client calls `authClient.signIn.anonymous()`. Better Auth creates a `user` row (`isAnonymous = 1`) and a session cookie (`HttpOnly; Secure; SameSite=Lax`, 30-day rolling expiry). All swipes and the `served` record are keyed to that user id. **This is what makes the product work**: anonymous dislikes are as valuable as likes.
- The client keeps its own copies of everything in IndexedDB (§7.4), so the Liked screen and the deck work offline and survive cookie loss.
- The Liked screen shows a persistent, dismissable-per-session banner: *"You're not signed in. Your list is saved only on this device."* with a sign-in button. (Copy note: Safari deletes script-writable storage and cookies after 7 days without a visit. That's the honest reason to make an account.)
- `/about/`: what's stored (a random id, swipes, no PII), that swipes are aggregated, CC BY-SA credit, how to delete data.

### 7.2 Sign-in: Google and GitHub

Better Auth `socialProviders: { google, github }`, both in Milestone 4. Routes are Better Auth's: `app.on(['GET','POST'], '/auth/*', c => auth.handler(c.req.raw))`. Client uses `createAuthClient` from `better-auth/solid`. Instantiate `auth` per request from `env` (D1 binding lives on `env`), memoized per isolate. CSRF: Better Auth checks Origin; app routes additionally require `X-Requested-With: fetch` on `POST`/`DELETE`.

### 7.3 Merge on sign-in (idempotent, both directions)

1. **Server** — the anonymous plugin's `onLinkAccount({ anonymousUser, newUser })` hook, in one D1 `batch()`:
   - `swipe`: insert the anonymous user's rows under `newUser.id` with `ON CONFLICT(user_id, card_id) DO UPDATE` keeping the **newer `swiped_at`**; adjust `word_stats` only for rows whose verdict actually changed.
   - `served`: union of both blobs, ordered by first appearance, trimmed to the cap.
   - Better Auth then deletes the anonymous user (default), cascading its rows.
2. **Client** — after redirect, `POST /api/sync` with every unsynced swipe from IndexedDB (idempotent on `swipe.id`), then `GET /api/me/likes` and replace the local liked list with the server's. From here the server is the source of truth and IndexedDB is a cache.

### 7.4 Offline-first behaviour

**Stores (IndexedDB, via `idb`):**
- `stack` — cards not yet swiped, in serve order. Target ≥ **150** buffered; fetch `n=100` whenever online and `stack.length < 60`, and on app start.
- `served` — set of every card ID this device has ever received (mirror of the server record; sent as `known=` on the first fetch after a cookie loss so the server can rebuild its record).
- `swipes` — every swipe `{id, cardId, word, verdict, bucket, shownAt, swipedAt, synced}`; also the source for the Liked screen (verdict = 1).
- `settings` — show-definitions default, theme.

**Sync:**
- Each swipe is written locally first, then the queue drains: `POST /api/sync` with up to 500 unsynced swipes, on `online` events, app start, visibility change, and after every 10 local swipes. Success marks them `synced`. Failures retry with backoff; nothing blocks the UI.
- `POST /api/sync` returns per-item results, so partial failures don't re-send the whole batch.
- The Liked list never waits on the network: signed-in users see local data immediately and a background `GET /api/me/likes` reconciles (server wins on conflicts).

**Shell:** service worker precaches Astro's `dist/` (HTML, CSS, JS, fonts); network-first for HTML so deploys propagate, cache-first for hashed assets. API responses are never cached by the SW. Offline indicator: a small dot in the dock/top bar plus the unsynced count on the Liked screen.

**Repeats:** the server's `served` record is authoritative; the local `served` set is the belt to its braces. Together they guarantee a user never sees a card twice (until the 30k cap rolls).

---

## 8. API (Hono, same origin)

Types flow to the frontend through `hc<AppType>()`. All bodies validated with zod.

| Method & path | Session | Purpose |
|---|---|---|
| `GET /api/feed?n=100&known=` | any (creates anon) | Next batch (§6.4). Updates `served`. `known` (optional, JSON array, ≤ 30k) seeds `served` after cookie loss. |
| `POST /api/sync` | any | Array of swipes (≤ 500): `{id, cardId, verdict, bucket, shownAt, swipedAt}`. Idempotent on `id`; per-item status. Updates `word_stats`; adds card IDs to `served`. |
| `DELETE /api/swipes/{cardId}` | any | Remove one card from liked list: delete its row and decrement its stats. |
| `GET /api/me` | any | `{ user: { id, isAnonymous, name, image }, providers: ['google','github'] }`. |
| `GET /api/me/likes?cursor=&limit=200` | any | Liked cards, newest first, full card payload. |
| `DELETE /api/me` | signed-in | Delete account and all rows. |
| `GET /api/cards/{id}` | none | One card by ID, including non-primary origins. `Cache-Control: public, max-age=86400`. |
| `GET /api/words/{word}/etymologies` | none | All retained cards for a headword, in etymology order. |
| `GET /api/words/{word}` | none | Legacy primary card by headword. `Cache-Control: public, max-age=86400`. |
| `/auth/*` | — | Better Auth handler. |
| `GET /healthz` | none | Pings both D1s and KV. |

Card payload (shared type in `packages/shared`):

```ts
type Card = { id: string; word: string; etymNo: number | null; ipa: string | null; pos: string[]; definition: string; defPos: string;
              etymology: string; tier: string; shape: string; etymBand: string;
              bucket?: 'confirmed' | 'promising' | 'fresh' | 'wild' }
```

Errors: `{ error: { code, message } }` with matching status. Rate limits via the binding: `/api/feed` 1 req/s per user, `/api/sync` 2 req/s.

---

## 9. Frontend spec

### 9.1 Routes & layout

- `/` — **Feed**. Full-height card stack from the local `stack`; top card interactive, next one peeks behind it. Card shows: **word** (large), **IPA** (muted), **etymology** (scrollable if long), a "Wiktionary · CC BY-SA" line, and a **"Show definition"** button that reveals the definition with its part-of-speech tag in place (animated expand; the card grows or the etymology scroll region shrinks). A "Always show definitions" switch in a small settings sheet persists to `settings`. Buttons under the card on all sizes: ✕ and ♥, plus an "undo" affordance for 5 s after a swipe (undo re-shows the card and deletes the swipe locally and, if synced, on the server).
- `/liked/` — **Liked**. Reverse-chronological liked cards from local `swipes`, tap to expand (definition shown expanded here), swipe-to-remove on mobile / ✕ on desktop, client-side search, copy-all as text. Anonymous banner (§7.1); unsynced count when offline.
- `/about/` — static: what it is, data/privacy, credits.
- Navigation: **mobile (< 768 px)** — bottom dock, two items (Feed / Liked), safe-area aware (`env(safe-area-inset-bottom)`). **Desktop** — top bar with the same two items plus sign-in / avatar. Same component; CSS decides placement. Both carry the offline dot.
- Empty stack while offline: a card that says so and how many swipes are waiting to sync.

### 9.2 Gesture spec

- Pointer events on the top card; horizontal drag translates + rotates (`rotate(dx / 20 deg)`); overlays "Interesting" / "Not for me" fade in past 40 px.
- Commit when release velocity > 0.5 px/ms **or** displacement > 35% of card width; else spring back.
- Vertical scroll inside the etymology must still work: capture the pointer only once `|dx| > |dy|` and `|dx| > 10`.
- Keyboard: `←` dislike, `→` like, `d` toggle definition, `z` undo. Buttons animate like a swipe.
- `prefers-reduced-motion`: crossfade instead of fling.

### 9.3 Client state

- `feed` store: `stack: Card[]` (mirrors IndexedDB), `pendingUndo?: Card`, fetching/online flags. Prefetch rule in §7.4.
- `swipes` store: IndexedDB-backed, sync queue (§7.4).
- `session` store: Better Auth's `useSession()`.
- `settings` store: show-definitions default, theme (reuse RWG's `theme.js` approach: applied in `<head>` before paint).
- PWA: `manifest.webmanifest` (standalone display, icons), service worker per §7.4.

### 9.4 Build & dev

- `apps/web/astro.config.mjs`: `output: 'static'`, `integrations: [solid()]`, PWA plugin, Vite dev proxy `/api` and `/auth` → `http://127.0.0.1:8787` (wrangler dev).
- `apps/api/wrangler.toml`: `main = "src/index.ts"`, `[assets] directory = "../web/dist"`, `run_worker_first = ["/api/*", "/auth/*"]`, `[[d1_databases]]` ×2, `[[kv_namespaces]]`, `[triggers] crons = ["*/5 * * * *"]` (feed pools), rate-limit bindings, `[vars]` tunables. Secrets via `wrangler secret put`: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`.
- Local D1: `wrangler d1 execute DICT --local --file=fixtures/etymology-500.sql` (500-word fixture in `apps/api/fixtures/`).
- Playwright e2e against `wrangler dev` with the fixture and a mocked OIDC provider; one suite runs with `context.setOffline(true)`.

---

## 10. Milestones (each ends with a review)

**M0 — Data pipeline** (in the RWG repo)
- `database/derive_etymology.py` with the §4.1 classifier, `prior`, `shape`, `etym_band`; outputs `etymology.db`, `etymology.sql`, report; `--check`; assets on the release; README section.
- ✅ Pool between 130k and 170k; the report's 25 `morph` samples contain no stories and its 25 `story`-under-40 samples contain no plain "X + -y" morphology (fix the regex until true); `.sql` imports into a local D1 with matching row count.

**M1 — Worker skeleton, read-only feed**
- Monorepo; Hono app; `/healthz`; `DICT` binding; `GET /api/feed` returning `wild` cards only (no `served` yet); `GET /api/words/{word}`; static assets serving an Astro placeholder; `wrangler deploy` to a scratch Worker.
- ✅ vitest (workers pool) green; `curl '/api/feed?n=100'` returns 100 distinct cards; deploy works; `wrangler tail` shows ≤ 101 rows read per fetch.

**M2 — Frontend deck + Liked, offline-first, local only**
- Astro + Solid; Feed and Liked screens; gestures; definition toggle + setting; dock/top bar; IndexedDB stores (`stack`, `served`, `swipes`, `settings`); prefetch rule; service worker; manifest; theme; anonymous banner.
- ✅ Playwright: swipe right adds to Liked and survives reload; with `setOffline(true)` after one fetch, 100 swipes work and Liked updates; back online, nothing is lost; keyboard works; Lighthouse mobile ≥ 90 perf/a11y/PWA.

**M3 — Persistence + algorithm**
- `APP` migrations; Better Auth with the anonymous plugin (no social yet); `served` record; `POST /api/sync` (idempotent upsert + stats delta + served update); `DELETE /api/swipes/{word}`; `word_stats` seeding script; lane pools (confirmed / promising / fresh) cron → KV with fill-through; Thompson sampling under the flat prior; slot composition + interleave; `known=` reseed; local on-demand stats report script; rate limiting.
- ✅ Unit tests for scoring, Beta sampler (mean/variance sanity), interleave pattern, refill; integration test proves a 100-card fetch costs ≤ 101 rows read and 1 write, and a 100-swipe sync of 50 likes and 50 dislikes costs ≤ 650 rows written including index updates; a simulated user of 5,000 fetches never receives a repeat; one like moves a card into the promising lane at the next pool refresh, two lefts from other users do not remove it, and five looks scoring at or above `CONFIRM_SCORE` move it into confirmed while five looks at exactly average park it; every lane query uses its own index and a pool refresh reads no more than `FRESH_POOL_SIZE` plus the rated lanes' populations; the local report script produces global like-rate, like-rate by lane, band and shape, and lane populations from exported tables.

**M4 — Accounts**
- Google + GitHub providers; `onLinkAccount` merge (swipes + served); post-login sync + likes reconcile; `GET /api/me/likes`; `DELETE /api/me`; sign-in/out UI and avatar.
- ✅ E2E with a mocked OIDC provider: anonymous swipes (some made offline) → sign in → all likes appear under the account and none repeat; sign in on a second device → union of both.

**M5 — Production**
- Production Worker, D1s, KV, secrets; custom domain; GitHub Actions: on push → test, build, `wrangler deploy`; on `database/RELEASE` change → create `dict-<tag>`, import, update `database_id`, seed missing `word_stats`, deploy; weekly `wrangler d1 export` of `APP` to R2. Restore drill: import the export into a fresh D1 and point a preview Worker at it.
- ✅ Restore drill documented and passing; `docs/RUNBOOK.md` covers release, restore, rotating secrets, and running the local stats report.

**M6 — Optional: RWG reads from the Worker**
- Third D1 with the full dictionary (needs Workers Paid for the import); port `get_words.php` to `GET /api/words/random` (same params, same JSON); CORS for `randomwordgenerator.info`; RWG's `tests/words-api.test.mjs` passes against it; flip RWG's `WORD_API_URL`.

---

## 11. Conventions for the coding agent

- **Repo layout**
  ```
  etymology-feed/
    apps/api/      Hono Worker: src/{index,env,auth,feed,sync,admin,cron}.ts, src/db/schema.ts, drizzle/, fixtures/, wrangler.toml
    apps/web/      Astro + Solid: src/{pages,components,lib,stores,styles}, public/manifest.webmanifest
    packages/shared/  Card type, scoring.ts, interleave.ts, classifier fixtures (pure, vitest)
    docs/          SPEC.md (this file), DECISIONS.md, RUNBOOK.md
    .github/workflows/ci.yml, deploy.yml, dictionary-release.yml
  ```
- TypeScript strict everywhere; no `any`; `biome` for lint/format; API types only via `hc<AppType>()` and `packages/shared`.
- Every D1 query in a hot path (`feed`, `sync`) has a comment stating its expected rows read/written and the index it uses. No `ORDER BY random()`, no unbounded scans, no N+1; use `db.batch()` for multi-statement writes; pass lists as JSON + `json_each`.
- Handlers are thin; logic lives in plain functions that take `{ dict, app, kv }` so tests can run them against the workers vitest pool.
- Offline is a first-class test target: every feature PR includes one offline scenario.
- Tests are part of the milestone, not an afterthought. Prefer integration tests through the HTTP surface.
- Commit per logical change; PR per milestone with a short note on what was decided and why.
- Don't introduce: Durable Objects, Queues, a second Worker, a CSS framework, a state-management library, a swipe library, Postgres/Neon/Supabase, a hosted auth service, or a sync framework (the queue in §7.4 is ~100 lines).
- When unsure whether something is in scope: it isn't. Ask.

---

## 12. Decisions made and what stays open

Settled in this revision: all-TypeScript on Cloudflare; offline-first with a 150-card local stack; selection by etymology text (§4.1) with all tiers and shapes kept; no retirement rule; definition hidden behind a toggle; server-side `served` record per user; Google + GitHub OAuth.

Still to decide, not blocking: product name and domain; whether anonymous users get a "sign in to save" nudge after N likes (suggest: after 10, once). The §4.1 thresholds are expected to move once §6.5 has data; that's a scheduled review, not an open question.

---

## 13. Sources consulted

- RWG repo: `README.md`, `database/schema.sql`, `database/build.py`, `database/build-report.txt`, `public/api/get_words.php`, `.github/workflows/deploy.yml`; release `dictionary-2026-09-20b` profiled locally (classifier and band tables in §2).
- Cloudflare D1 pricing and limits: https://developers.cloudflare.com/d1/platform/pricing/ ; free-tier enforcement (Sept 2026): https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- npm versions checked 2026-09-25: astro 7.3, @astrojs/solid-js 7.0, solid-js 1.9, better-auth 1.7.
