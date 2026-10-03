# Production runbook

## Current state — 2026-09-28

The public app is live at https://etymologyfeed.com on merged commit
`2be5a00e03972acf30445971ca167b6bd4242d9d`. The production deployment workflow
passed after the owner resolved the initial root-domain DNS conflict. Live
checks verified HTTPS, the expected commit/dictionary, both paired Bluffs, the
static shell, and 100 distinct feed cards. The initial release assets are published
and the first GitHub Actions backup passed. M5 remains in progress: real
Google/GitHub sign-in and post-launch usage metrics still need verification.

Launch evidence: [deployment](https://github.com/peterchinman/etymology-feed/actions/runs/36423935011),
[private backup workflow](https://github.com/peterchinman/etymology-feed/actions/runs/36424514174),
and [initial dictionary release](https://github.com/peterchinman/etymology-feed/releases/tag/feed-2026-09-28-v4).

| Resource | Production target |
| --- | --- |
| Origin | `https://etymologyfeed.com` |
| Cloudflare account | Peter Chinman, `718c6831c05a1caaaa1cbea88dd211c2` |
| Active zone | `da274e3d8816f45b2d816e80c3480ab3` |
| Worker | `etymology-feed` (live) |
| APP | `etymology-feed-app`, `a0961bd8-4f99-4af7-b1da-2f00cd82b44d` |
| Initial DICT | `etymology-feed-dict-20260928-v4`, `bbcea6f6-1c37-4ed4-bad0-dbac396bc425` |
| CACHE | `4fa55f4da70f460ca8d2dca9117361c4` |
| Private R2 bucket | `etymology-feed-backups` |

The owner selected Workers Paid to import everything at once. The domain's Free
zone plan is separate and can remain Free. Do not downgrade Workers until actual
CPU, D1 query limits, daily reads/writes, and other apps' account usage have been
checked. The original free-plan estimates are not a validated downgrade plan.

Use Node 24, Python 3.11+, and `npm ci`. All commands below run from the repo root.
`apps/api/wrangler.production.json` explicitly targets production;
`apps/api/wrangler.toml` remains scratch/local development.

## Credentials

The Worker has `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. The OAuth callbacks are:

- `https://etymologyfeed.com/auth/callback/google`
- `https://etymologyfeed.com/auth/callback/github`

Google's audience/consent settings must permit the intended users. No mock OAuth
issuer belongs in production.

The repository Actions secret `CLOUDFLARE_API_TOKEN` was added on 2026-09-28.
The read-only **Check production credentials** workflow passed from GitHub:
Worker, APP/DICT metadata, KV, R2 bucket, account, zone, and routes were accessible.
The deployment rerun and first backup workflow also passed, exercising their
required write permissions.

Token permissions, scoped to this account: Workers Scripts Edit, Workers KV
Storage Edit, D1 Edit, Workers R2 Storage Edit, Account Settings Read; scoped to
etymologyfeed.com: Zone Read, Workers Routes Edit. The account ID is configured
in the workflows. GitHub's repository secret is available to their `production`
environment. Local Wrangler OAuth does not authenticate GitHub runners.

## Source and initial data

The pinned full source is RWG's published `dictionary-2026-09-28` release.
`database/SOURCE.json` records its SHA-256. This does not change RWG's website
release pin. Classifier v4 produced 100,537 cards across 95,841 headwords, with
all card rows matching the accepted local build, including both paired Bluffs.

Production DICT is imported and APP has migration `0000_initial` plus 100,537
initial statistics rows. Initial import costs were 502,724 DICT writes and
201,074 APP seed writes. Do not repeat those imports into the existing databases.
The initial feed release `feed-2026-09-28-v4` is published from merged code with
the five validated assets prepared in `data/production-release/`.

## App deployment

Both app and dictionary releases test the exact commit that will be deployed.
Dictionary release jobs resolve main once, run the full checks on that SHA, and
refuse the switch if main advances before the mutation step.

A push to main runs the local fixture tests, browser tests, and packaging checks
on Linux, then deploys. A stale main run is skipped. All production
mutations share the `etymology-production` Actions concurrency group.

The durable desired dictionary is the private R2 object
`production/dictionary.json` with `database_id`, `database_name`, and `release`.
Every deploy reads it into ignored `apps/api/.wrangler.production-runtime.json`
so an ordinary app change cannot revert DICT to the initial committed binding.
Pool cache keys include `DICT_RELEASE` and expire after one day.

For a manual operation, first ensure no production Actions job is running;
local commands do not acquire the Actions concurrency lock:

```sh
npm run build:web
python3 scripts/production.py deploy
```

This resolves current DICT, applies APP migrations, deploys the Worker and custom
domain, then tests HTTPS, health, the static shell, both paired Bluffs, and a full
100-card feed. `/healthz` reports `appCommit` and `dictRelease` with `no-store`;
the smoke check must observe the expected values before accepting the deployment.
It retries briefly for DNS/certificate/edge propagation, with timeouts on every
request. The feed check creates one anonymous session/served record and
does not submit ratings.
Check real sign-in for both providers, anonymous-to-account reconciliation,
cross-device likes, account deletion, and offline reconnection after launch.
Local mocked OAuth tests do not prove provider-console settings are correct.

If domain attachment fails with Cloudflare error `100117`, inspect existing DNS
records for that exact hostname. The initial launch encountered this conflict;
the Worker upload succeeded but the custom-domain step failed. Resolve the
conflicting web record, then rerun the failed deployment job. Keep unrelated
mail and verification records. Cloudflare documents the existing-CNAME restriction
in its [Custom Domains guide](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Dictionary releases

Build and validate from the pinned full source:

```sh
python3 database/derive_etymology.py --source data/source/dictionary.db --output-dir data/dictionary
python3 database/derive_etymology.py --source data/source/dictionary.db --output-dir data/dictionary --check
python3 scripts/production.py prepare data/dictionary
python3 scripts/production.py verify data/dictionary
```

Publish `etymology.db`, `etymology.sql`, `etymology-report.txt`, `word-stats.sql`,
and `manifest.json` on a `feed-*` release in this repository. Preserve Wiktionary /
kaikki.org CC BY-SA 4.0 attribution. The release tag must point to code merged
into main. Do not publish the initial tag before the production PR is merged.

The release workflow checks provenance, hashes, SQL/SQLite equality, seed contents,
and membership against the previous release. It also checks matching SQLite/SQL
metadata and a complete integer shuffle permutation. It imports a new immutable DICT,
seeds missing statistics without resetting ratings, updates the R2 pointer,
and deploys. The previous DICT is retained. A pointer-write or deployment failure
attempts to restore the previous pointer and deployment; it does not undo APP
writes. Every import attempt gets a unique DICT name, including quick retries.

Current limitation: releases removing existing card IDs are refused before remote
changes. Retired-card membership needs explicit support before such releases can
be automated. Seeded IDs and ratings from a failed release remain in APP. The
feed resolves candidates against its active DICT and fills missing slots from
that dictionary, without deleting ratings or recording unavailable IDs as served.
Recovery reads at most 1,000 additional dictionary rows in indexed pages; normal
requests with complete pools keep their existing read budget. If this bounded
scan cannot fill the batch and has not exhausted the dictionary, it returns a
retryable 503 without writing served history. IDs known from a different release
do not count as proof of dictionary exhaustion.

Local failure-injection tests cover seed, pointer-write, deployment, and smoke
check failures followed by retry; Worker/D1 integration tests cover full batches,
nonrepetition, and preservation of a like received before rollback. If rollback
itself fails, stop further release operations, inspect the retained databases and
R2 pointer, and rerun the deployment for the intended release. Do not delete APP
statistics to make rollback work.

## Private backups

**Back up production APP** runs Sundays at 07:17 UTC or by manual dispatch.
For a local run while no production workflow is running:

```sh
python3 scripts/production.py backup
```

Exports can briefly block APP requests. The script captures Wrangler's signed
export URL instead of logging it, verifies SQLite integrity and foreign keys,
compresses the export, and uploads `app/<UTC timestamp>.sql.gz` plus `.json` to
R2. The manifest records checksums, counts, APP/DICT identities, actual deployed
Worker version IDs and app commit, plus the backup script commit and its migration
hashes. It records desired dictionary state separately from the deployed binding;
`dictionary_source` flags the fallback if an older Worker lacks release metadata. The private `app/` prefix has a 90-day lifecycle policy;
`production/dictionary.json` is outside that prefix. Never publish APP backups as
release assets or GitHub artifacts.

## Restore drill

Passed on 2026-09-28 against backup `app/2026-09-28T01-46-25Z`:

- Imported into isolated APP `1db38c6e-d6c3-4b16-80f9-d2f2a470dccf`.
- Compared every restored row with the export, including 100,537 statistics rows
  and the migration record; integrity and foreign keys passed.
- Deployed `etymology-feed-restore-20260928` with an independent CACHE and an
  access token required for every request, including assets.
- Verified unauthenticated requests were blocked; authorized requests returned
  100 distinct cards, established a session, stored a like, and retrieved it.
  No real OAuth providers were enabled.
- Import, comparison, deploy, and HTTP checks took 24.4 seconds. All temporary
  Cloudflare resources were deleted afterward.

This was a pre-launch snapshot with no existing users, sessions, or swipes.
Repeat the drill after real usage to verify recovery of historical user data.
Local evidence is in ignored `data/restore-drill/verification.json`.

To repeat:

1. Download the chosen `.sql.gz` and `.json` objects to a private ignored folder,
   naming them `app.sql.gz` and `manifest.json`. For example:

   ```sh
   npx --no-install wrangler r2 object get etymology-feed-backups/app/2026-09-28T01-46-25Z.sql.gz --remote --file data/restore-drill/app.sql.gz --config apps/api/wrangler.production.json
   npx --no-install wrangler r2 object get etymology-feed-backups/app/2026-09-28T01-46-25Z.json --remote --file data/restore-drill/manifest.json --config apps/api/wrangler.production.json
   ```

2. Create a fresh D1 and KV namespace with unique names:

   ```sh
   npx --no-install wrangler d1 create etymology-feed-restore-YYYYMMDD --location enam --update-config=false --config apps/api/wrangler.production.json
   npx --no-install wrangler kv namespace create etymology-feed-restore-YYYYMMDD --update-config=false --config apps/api/wrangler.production.json
   ```

3. Copy the production config to ignored
   `apps/api/.wrangler.restore-runtime.json`. Set `name` to the restore Worker,
   `main` to `src/restore.ts`, APP and CACHE to the fresh IDs, and DICT to the
   backup manifest's dictionary. Set `routes: []`, `triggers.crons: []`,
   `workers_dev: true`, `preview_urls: false`, `assets.binding: "ASSETS"`,
   `assets.run_worker_first: true`; remove `BETTER_AUTH_URL` and any OAuth/mock
   variables. Keep `DICT_RELEASE` consistent with that dictionary. Do not reuse
   the completed drill's deleted resource IDs. Do not pre-apply migrations.

4. Build and run:

   ```sh
   npm run build:web
   python3 scripts/restore-drill.py data/restore-drill --config apps/api/.wrangler.restore-runtime.json
   ```

   The script first requires the guarded entrypoint, protection for all assets,
   the intended account, unique isolated APP/CACHE bindings, and the manifest
   dictionary. It then verifies checksums, refuses a nonempty APP, compares restored rows,
   installs fresh secrets, deploys the guarded Worker, and records HTTP results.

5. Record the result, then delete only the named temporary Worker, D1, and KV
   resources. Never delete production APP/DICT/CACHE or the backup objects.
   A failed drill should retain evidence for diagnosis before cleanup.

## Secret rotation

Use the explicit production config, e.g.:

```sh
npx --no-install wrangler secret put GOOGLE_CLIENT_SECRET --config apps/api/wrangler.production.json
```

Enter values at the prompt, never in arguments or chat. Secret changes deploy a
Worker version. Coordinate provider-secret rotation with a tested callback.
Changing `BETTER_AUTH_SECRET` can invalidate sessions. For the Actions token,
replace the repository secret, run the read-only credential check and a real
operation, then revoke the old token. Local secret files stay ignored.

## Local stats report

Resolve current bindings with `python3 scripts/production.py render`, then export
only APP's `swipe`, `word_stats` and `rater` tables using
`--config apps/api/.wrangler.production-runtime.json`, `--remote`, `--table`, and
`--no-schema`. Use the selected release's local dictionary:

```sh
python3 apps/api/scripts/report_stats.py --swipes-sql /private/tmp/ef-swipes.sql --word-stats-sql /private/tmp/ef-word-stats.sql --raters-sql /private/tmp/ef-raters.sql --dict-db data/dictionary/etymology.db > /private/tmp/ef-report.json
```

The report reads no deployed DICT data. Keep private exports outside git and
remove them when finished. SPEC §6.5 describes interpretation and tuning.
SPEC §6.6 describes the `raters` section and how to flag a rater; the README
has the command.

## References

- [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
