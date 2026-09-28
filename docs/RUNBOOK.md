# Production runbook

M5 is in progress. This document records the launch sequence and unresolved
setup; it is not evidence of a completed deployment or restore drill.

## Target and current state

- Public origin: `https://etymologyfeed.com` (purchased).
- Existing authenticated Cloudflare account: Peter Chinman,
  `718c6831c05a1caaaa1cbea88dd211c2`.
- Public DNS observed on 2026-09-27: Porkbun nameservers. An active Cloudflare
  zone is required for the Worker custom domain.
- `apps/api/wrangler.toml` still names scratch resources. Production Worker,
  APP, DICT, CACHE, and backup bucket have not been configured by this milestone.
- Reviewed data: classifier v4, 100,537 cards, 95,841 headwords.
  `database/SOURCE.json` still identifies an unpublished local source.
- `.github/workflows/ci.yml` checks the app, local database integrations,
  offline use, account reconciliation, and dry-run packaging. It does not deploy.

## Owner setup

1. Add the domain to the intended Cloudflare account and change the registrar's
   nameservers to the pair Cloudflare assigns. Preserve any existing mail and
   other DNS records. The registration can remain at Porkbun.
2. Confirm the account's Workers plan. The spec currently budgets for Free;
   retain that unless Peter chooses otherwise. Free permits 100,000 D1 rows
   written per day across the account, including index maintenance. The initial
   dictionary alone exceeds that before seeding APP. A free launch requires
   resumable imports and seeding across quota resets, with allowance for other
   applications. Workers Paid starts at $5/month plus applicable overages.
3. Create production OAuth apps for the launch providers. The spec selects
   Google and GitHub. Use these exact callback URLs:

   | Provider | Callback |
   | --- | --- |
   | Google | `https://etymologyfeed.com/auth/callback/google` |
   | GitHub | `https://etymologyfeed.com/auth/callback/github` |

   Use `https://etymologyfeed.com` as the homepage/origin. Configure Google's
   production audience/consent screen before testing with non-test users.
   Enter credentials directly into Worker secrets or an ignored local secret
   file for upload; never put values in a commit, issue, PR, or chat.
4. Supply a scoped Cloudflare API token to the repository's GitHub Actions
   production environment as `CLOUDFLARE_API_TOKEN`, with
   `CLOUDFLARE_ACCOUNT_ID` identifying the account above. Local Wrangler OAuth
   does not authenticate GitHub runners. Final scopes depend on the deployment
   and backup workflows; scope them to this account and zone, and separate
   backup credentials where practical. Do not use the global API key.
5. Enable R2 for private weekly APP backups if it is not already enabled.
   Standard storage includes 10 GB-month free; retention and account-wide usage
   must stay within the agreed budget. Record the bucket name after creation.

## Release and first deployment sequence

1. Publish the reviewed full source as a new RWG dictionary release. Update
   `database/SOURCE.json` with its real tag and `published: true`; confirm the
   downloaded bytes match the pinned SHA-256. The old `dictionary-2026-09-20b`
   cannot substitute: it lacks the required entry-to-etymology links.
2. Derive the feed artifact using this repo's builder. Run `--check`, the
   regression suite, and SQL round-trip verification. Compare all card IDs,
   paired definitions, and etymologies against the accepted local baseline.
   Both Bluffs and the laughter sense of haha must remain. Publish the database,
   SQL, report, and checksums on an Etymology Feed release.
3. Create a separate production APP and CACHE plus an immutable DICT for that
   feed release. Apply `apps/api/drizzle/0000_initial.sql` through Wrangler's
   migration command to the fresh APP. Import DICT and seed missing statistics
   only; do not reset existing ratings on subsequent releases.
4. Commit explicit production bindings, the custom domain, and
   `BETTER_AUTH_URL=https://etymologyfeed.com`. Keep scratch/local development
   separate. Enable Worker logs and sampled traces. Generate binding types.
   Production must have a fresh random `BETTER_AUTH_SECRET` and the configured
   OAuth client IDs/secrets; it must not enable `MOCK_OAUTH_ISSUER`.
5. Implement the app deployment, dictionary release, and weekly backup
   workflows. Deploy only after checks pass. Serialize app and dictionary
   deployments so a stale config cannot undo a dictionary switch. Make the
   selected DICT ID durable in the release configuration. If using Free,
   checkpoint both import and seeding and wait for quota resets; a per-run
   budget is not an account-wide daily budget.
6. Verify the new DICT and complete APP seed before switching traffic. Refresh
   the cached pools for the new dictionary; an old `pools:v3` may contain IDs
   removed by a release. Keep the previous DICT until the new release passes
   smoke checks and its rollback window has ended.
7. Test HTTPS, `/healthz`, both Bluff cards, anonymous swiping, real OAuth for
   each enabled provider, cross-device likes, account deletion, and offline
   use/reconnection. Check actual request CPU and D1 read/write metrics.

The current seed script defaults to 50,000 reported writes per run and emits
an `--after` cursor. It currently targets the default Wrangler configuration;
production environment/config selection must be added before using it for
production. A dictionary rebuild can change shuffle order, so resume a cursor
only against the same immutable DICT release.

## Weekly backup and restore drill

Implementation and remote drill are pending. Export APP during a quiet period:
D1 exports can temporarily block requests to that database. Store exports in a
private R2 bucket with a checksum, source APP ID, app commit, schema/migration
version, DICT release/ID, and export time. Backups include account and session
data; do not upload them as public release assets or CI artifacts. Set retention
after measuring export size against the account's available storage.

For the drill, retrieve an export, verify its checksum, and import it into a
fresh D1. Check integrity, foreign keys, table counts, representative likes and
aggregates, and migration state. Point an isolated preview Worker at the restored
APP and a separate CACHE, with no production domain, cron, or real OAuth
credentials. Restrict access to the preview because the restored APP contains
user data. Exercise reads and writes without touching production APP. Record the
backup timestamp, restored resource IDs, checks, and recovery duration here.

Restore drill status: **not run**. M5 is not complete until the remote drill
passes and the actual workflow commands/resource names are documented here.

## Secrets and rotation

Production secret upload/rotation commands will be recorded once the production
target exists. Always pass its explicit configuration/environment; the current
default is scratch. Wrangler `secret put` changes the deployed Worker, so rotate
within a planned deployment. Replace an OAuth secret in the provider console and
Worker together and test the callback. Treat a Better Auth secret change as a
potential session invalidation and verify the installed version's rotation
behavior before doing it. Replace the GitHub Actions Cloudflare token, verify a
deployment, then revoke the previous token. Keep secrets out of command arguments
and logs; use an interactive prompt or protected input file/stdin.

## Local stats report

Use the deployed release's local `etymology.db`. Export only APP's `swipe` and
`word_stats` tables using the explicit production configuration, then run locally:

```sh
python3 apps/api/scripts/report_stats.py \
  --swipes-sql /private/tmp/ef-swipes.sql \
  --word-stats-sql /private/tmp/ef-word-stats.sql \
  --dict-db data/dictionary/etymology.db > /private/tmp/ef-report.json
```

This analysis does not read deployed DICT. Exporting APP is a remote operation;
retain the private inputs only as long as needed. Interpret and tune results using
SPEC §6.5; no scheduled production scans are needed for this report.

## References

- [Custom domains and active zones](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [D1 pricing and index writes](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
