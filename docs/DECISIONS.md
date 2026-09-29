# Decisions

## 2026-09-27 — Start M5 with CI and launch prerequisites

Peter has purchased `etymologyfeed.com`; use `https://etymologyfeed.com` as the
production origin. The existing Cloudflare login works, while public DNS still
uses Porkbun nameservers. Track DNS, OAuth, CI credentials, source publication,
the D1 bootstrap budget, and backup/restore work in `RUNBOOK.md`.

Add app CI now, using local D1/KV and mock OAuth. The browser harness supplies
its own test-only auth secret and origin so a fresh runner does not require a
developer's `.dev.vars`. Production deployment remains pending those setup
dependencies. M5 is incomplete until its remote restore drill passes.

## 2026-09-27 — Start production from one APP migration

No production APP data needs an upgrade before the first deployment.
The earlier schema migrations are folded into `0000_initial`, which creates
the final card-ID columns and indexes directly. Fresh local D1 databases are
used to verify it. Once production has data, new migrations remain incremental.

## 2026-09-27 — Merge anonymous activity into accounts (M4)

Use Better Auth's anonymous `onLinkAccount` hook with Google and GitHub sign-in.
For each card rated by both the guest and the account, keep the later swipe and
subtract the losing rating from `word_stats`; even two identical likes must
become one like after the merge. Move unique guest swipes, union served card IDs
in first-seen order, and let Better Auth delete the guest user. One D1 batch
contains the writes. After redirect, drain any remaining local swipes and
replace the local Liked cache with paginated server likes. Sign-out clears the
device's card and swipe caches so the next anonymous user cannot see them.
Account deletion removes the user's aggregate contributions and cascades their
APP rows. A local mock OIDC provider exercises the browser flow without real
Google or GitHub credentials; those credentials are configured at deployment.

## 2026-09-27 — Park slowly, confirm sooner; second looks after the frontier (§6.1)

The two lane transitions are not symmetric. A wrongly confirmed card keeps
getting looks and falls back out at a later refresh, because lanes are
recomputed from the counters every five minutes. A wrongly parked card gets no
looks, so that error is permanent in practice. The five-look rule treated both
alike: at a 20% base rate and weight 0.25 it parked a card twice as good as
average 13% of the time and confirmed an average card 59% of the time. Now
confirmation still needs `MIN_RATINGS` (5) looks at or above `CONFIRM_SCORE`
(0.55), but a liked card is parked only after `PARK_LOOKS` (15) looks below
0.5; cards between the two stay promising, where Thompson ranking already
shows low-mean cards less. A 40% card is then parked about once in two
thousand. Posterior confidence bounds were considered and would adapt the
sample size to the evidence, but they need two more columns and a square root
in SQL for a modest gain over these asymmetric thresholds; they remain the
upgrade path if per-lane like-rates show the thresholds mis-set.

The fresh lane is now never-liked cards ordered by fewest looks then best
prior, capped at `MIN_RATINGS` looks, instead of never-seen cards only. The
order means never-seen cards still fill the lane until the whole frontier is
exhausted, so nothing changes for over a year at current volumes and no
exploration budget is spent on second looks while new cards remain. After
that, cards passed over once return automatically rather than never; a card
never liked in five looks is parked. The same unrated index serves the query.
The initial promising partial index has the two-threshold predicate; the pool
builder uses it when the vars match the defaults and
otherwise scans with a logged warning. The report gains `--park-looks` and a
never-seen count beside the fresh lane total.

## 2026-09-27 — Weight a left swipe below a like (§6.1, §6.2)

A left is the default action in a swipe feed: sometimes active dislike, often
just "next". Treating it as a full negative parked good cards. If the base
like-rate is 20%, a card liked once in four looks is average, yet the
lanes-only design parked it forever. Each left now counts as `DISLIKE_WEIGHT`
of a negative under a flat `Beta(1, 1)` prior on that weighted scale:
`score = (likes + 1) / (likes + w * dislikes + 2)`. The weight is the odds of
the base like-rate, `w = p / (1 - p)`, so `likes >= w * dislikes` is exactly
"like-rate at or above the average card". The default 0.25 assumes 20% until
the §6.5 report prints the observed rate and the weight it implies; the report
also gains `--confirm-score`. Looks stay unweighted because a left still proves
exposure. This replaces `PRIOR_STRENGTH` and `BASE_RATE` with one var.

Lane rules changed accordingly. Promising drops its dislike test: a like buys a
card five looks, and Thompson ranking inside the lane already shows it less as
lefts arrive, so two strangers swiping past no longer veto a like. Confirmed
requires `score >= CONFIRM_SCORE` (0.55) so that confirmed means clearly above
average rather than exactly average; one like in five looks scores 0.5 and is
parked, two likes in five looks scores 0.64 and is confirmed. Parked now covers
lefts with no likes and five looks below the margin; the fresh lane still
admits only never-seen cards, since one look per card already takes over a year
at current volumes. The final promising partial index has no dislike clause;
the confirmed index keeps its
`score >= 0.5` predicate and the query narrows to the bound margin, which the
plan test confirms still uses the index. Once ratings exist, a weight change
also requires rescoring the rated rows with the README statement.

## 2026-09-27 — Feed lanes by information state; flat prior for rated cards (§6)

Replace the recommended/unknown pools and the five-rating gate with lanes
defined by what is known about a card: confirmed (`n >= 5`, `likes >=
dislikes`), promising (at least one like, not outvoted, `n < 5`), fresh
(`n = 0`, ordered by the heuristic prior), and parked (outvoted; wild only).
Each 20-card block is 6/6/6/2 with fill-through, so an empty lane hands its
slots down instead of leaving a cliff. The swipe `bucket` now records the lane
the card came from rather than the slot, so per-lane like-rates are honest;
the sync endpoint still accepts the legacy `rec` and `unknown` values from
offline queues.

Why redesign rather than reserve a share of `rec` for one-to-four-rated
cards: with the release downloaded locally (`data/etymology.db`, gitignored),
16,352 of 147,954 cards (11.1%) sit at the prior clamp of 0.8, almost all
200+ character etymologies. Both old pools were therefore arbitrary slices of
that tie group, and under the `K = 5` heuristic prior one like on a 0.7 card
(posterior 0.75) still trailed 18,981 unrated cards; two likes on a 0.6 card
trailed 25,537. The heuristic prior was doing two jobs. It now only orders
the fresh lane; rated cards are scored with a flat `Beta(1, 1)` prior
(`PRIOR_STRENGTH = 2`, `BASE_RATE = 0.5`), so one like is 2/3 and one dislike
is 1/3. Re-centering on the observed like-rate becomes a var change plus one
indexed `UPDATE` of rated rows instead of a dictionary release.

Costs. The old refresh read up to 6,500 rows per run (500 + 3,000 + 3,000),
about 1.87M of the 5M daily reads. The new refresh reads at most
`FRESH_POOL_SIZE` plus the confirmed and promising populations, because those
two lanes are served by partial indexes: about 0.86M/day at launch and at most
2.6M/day with every lane full. On the 501-card fixture the refresh measured
503 rows read: 501 for the fresh lane and one per empty partial-index query.
The initial schema omits the unused general score index (which cost 100
writes per 100 swipes) and includes the partial promising index, which costs
writes only for qualifying rows. The KV key
moved to `pools:v3`; the first cron or feed request after deploy rebuilds it.
Web typecheck, lint, API, shared, and report tests pass.

## 2026-09-27 — Rate etymologies as distinct cards

Keep every etymology that passes the existing story and signal rule, with a
definition and preferred pronunciation from its own source entry. The source
dictionary must retain an entry number on meanings, pronunciations, and
etymologies; the old release cannot safely pair a secondary etymology with its
meaning because `meaning` lacks that link. `DICT.word` now has one row per
selected etymology, keyed by card ID. APP scores, swipes, and served history
use that ID so two senses of a headword can be shown and rated independently.
The previous longest-etymology card keeps its headword ID, preserving existing
APP and offline records; new cards use a deterministic content-derived ID.
The full local rebuild from the original extract produced **155,032 cards for
148,180 headwords**, in a 58 MB SQLite database and 47 MB SQL import. The old
published release has 147,954 cards. Every legacy primary card ID and its
etymology text survives the rebuild; some paired definitions and POS values
change because they now come from the matching source entry. The ignored local
preview and a 501-card fixture test both Bluff origins. The published release
remains on the old schema until a new source release is published and DICT is
replaced.

## 2026-09-27 — Run §6.5 reporting locally on demand

Remove the nightly stats cron, `stats:v1` KV snapshot, admin stats endpoint,
and its token. At zero users, a daily full scan would spend D1 reads even when
no one needs the report. A stdlib Python script combines data-only exports of
APP's `swipe` and `word_stats` tables with the pinned release's local
`etymology.db`, then writes the 7/30-day report as JSON. The exports are run
manually; Cloudflare notes that an export blocks other database requests, so
run them at a quiet time once the site has users. The script and exported
data stay local and are never committed. There is no way to reconstruct
earlier verdicts or deleted likes from the current-state `swipe` table; dates
use server `received_at`, so offline activity counts on its sync day.

Keep the five-minute pool cron: it serves live feed requests from one bounded
KV value instead of re-running pool-selection queries for every fetch. Its
288 KV writes/day fit under the 1,000/day free allowance. The local report
does not change the §4.1 classifier thresholds or the §4.3 prior; those
remain decisions for a later dictionary release based on observed rates.

## 2026-09-26 — M3 auth, quotas, and measurable D1 costs (§3.4, §5–8)

Use the current `auth` CLI with the anonymous plugin to generate the Better
Auth Drizzle tables into a separate file, re-exported from the APP schema.
The CLI's current package is `auth`; runtime auth uses the same plugin and is
instantiated from the request's APP binding and origin. Keep social providers
for M4. Use the free Rate Limiting binding's smallest supported 10-second
window: 10 feed requests or 20 sync requests per user per window. This caps
the requested average rates but permits short bursts; an exact per-second
limit is unavailable from this binding.

The M3 D1 integration fixture measures **100 card rows read and one served
row written** for a fresh 100-card fetch. A 100-swipe sync of 50 likes and
50 dislikes originally wrote **750 D1 rows**, despite only two SQL table
mutations per swipe, because D1 counts index updates in `rows_written`.
Removing the unused `idx_swipe_word` saved 100 writes. Removing the general
score index saved another 100 but lost the indexed cold-start ranking; a
replacement partial index restored that cost on first ratings. A measured
`WITHOUT ROWID` variant with `(user_id,word)` as its primary key saved 100
more writes, reaching 550 per 100 swipes. With no production users, retain
the simpler UUID primary key, the unique `(user_id,word)` lookup, and the
partial Liked index; drop only the unused word-only index. This preserves
indexed user/word lookup, user pagination, and Liked lookup without a table
rebuild or a composite-key stats cursor. **100 new swipes now write 650 D1
rows.** The §10 acceptance target was revised from ≤200 to the measured
≤650. The free daily 100k allowance supports at most roughly 15k such
swipes before auth, cron, and feed writes. The added nightly scan index was
removed because it increased the original measurement to 850. Revisit the
compact table only if measured usage approaches the free-plan write limit.
The 2026-09-27 multi-etymology decision supersedes the one-card-per-headword
assumption below. Each qualified source etymology is now its own card, paired
with a definition from the same source entry. Feed history, swipes, and scores
use card IDs. The former primary card retains its headword as ID to preserve
existing local and APP records; additional cards use deterministic content IDs.
The seed script meters actual `rows_written` and defaults to a 50k budget
per run (at most 80k when explicitly requested), so seeding 152k indexed rows
takes more than the spec's suggested two days on the free plan. A sync after
cookie loss may also write one extra served row to recover words that were
never fetched by that session.

Keep the required score and unrated indexes and add a partial recommended
index for the default `MIN_RATINGS=5`: the five-minute pool cron otherwise
scans the entire seeded score index while looking for rated words, exceeding
the 5M daily read budget. The `MIN_RATINGS` variable remains respected; a
value below five takes the general score-index path and needs new cost
measurements. The §6.5 report is run locally on demand from D1 table exports
and the pinned release database; its scan does not run on the Worker.

The `known` JSON is sent in URL-sized chunks after cookie loss, merging into
the server's served blob on successive fetches. A single 30k-word URL would
exceed practical request-target limits; the local served set suppresses any
repeats during recovery. The 5,000-fetch no-repeat simulation uses single
cards because the dictionary has only about 152k words and 5,000 distinct
100-card fetches would require 500k.

## 2026-09-25 — Product name and domain (§12)

Use **Etymology Feed** as the product name. Target **etymologyfeed.com** for the
custom domain in M5; confirm availability before registration. Neither choice
affects the data or API design.

## 2026-09-25 — Anonymous sign-in nudge (§12)

Show the suggested “sign in to save” nudge once after 10 likes. The persistent
anonymous banner on the Liked screen remains as specified in §7.1.

## 2026-09-25 — M1 wild feed sampling (§4.2, §10)

On the 500-word D1 fixture, fetching 100 random shuffle positions through
`json_each` read 301 rows. An indexed range of 100 positions read 100 rows.
M1 therefore picks a uniform random start in the dictionary's shuffled order
and reads 100 consecutive positions, wrapping at the end. Every word has the
same 100/N inclusion probability. With the one-row `meta` lookup, a fetch reads
101 rows, meeting the free-plan budget. M3's scored pools and served filtering
will be measured separately.

## 2026-09-26 — M2 offline shell (§3.1, §7.4, §10)

Use the spec's hand-written service-worker option. The build lists and hashes
every generated shell file, then writes `sw.js` with that precache. HTML is
network-first; static assets are cache-first; `/api/*`, `/auth/*`, and `/healthz`
are excluded. This keeps the PWA shell independent of a new build dependency.
The anonymous banner's sign-in control stays disabled until M4 adds providers.

## 2026-09-26 — M2 semantic visual system

Use five reusable typography roles: `display-voice` for words and headings,
`reading-voice` for etymologies and definitions, `body-voice` for sentences and
status, `label-voice` for short controls and navigation, and `caption-voice` for
source credit. “Instructive” was too narrow for controls, while “quiet” made
primary mobile navigation sound secondary. Icon glyphs use size tokens rather
than a text voice. Components select a role and may adjust its size through a
role custom property; they do not define their own font stacks or weights. The
single stylesheet groups color, type, spacing, surface, layout, and motion
tokens at the root, with dark-theme and narrow-layout overrides. Source CSS
contains no pixel literals. The two layout breakpoints use `rem`, since CSS
custom properties cannot be used in media queries.

## 2026-09-26 — M2 RWG theme family

Use the four [Random Word Generator themes](https://github.com/peterchinman/random-word-generator-site/blob/master/src/styles/style.css):
pink/blue palettes crossed with light/dark modes. The default pink palette
follows the device mode until the visitor explicitly toggles dark mode. Match
RWG's canvas, raised surface, accent, border, and shadow colors; map them through
the site's semantic tokens and use Georgia serif for all five voices instead of
RWG's Roboto Mono.
Blue-light raised text uses white rather than RWG's pale lilac so small text
meets contrast requirements. Keep palette and mode in IndexedDB, mirror them in
localStorage for the pre-paint theme, and honor the old light/dark preference.

## 2026-09-26 — M2 dictionary attribution placement

Remove the visible credit line from Feed and Liked cards. Link each word heading
to its original Wiktionary entry, and place the contributor, extraction,
adaptation, and CC BY-SA 4.0 notice in Settings. The [license](https://creativecommons.org/licenses/by-sa/4.0/legalcode)
allows attribution in a manner reasonable for the medium and context, while
asking for a link to the source material where practical. This keeps direct
entry links available and the credit accessible without repeating it on every
card. This user-requested placement replaces the per-card line in SPEC §3 and
§7.4; it does not change the dictionary's license.

## 2026-09-26 — M2 swipe motion model (§7.4)

Derive card motion from the gesture instead of fixed CSS transitions. The top
card tracks the pointer 1:1 with no transition in between. On release,
velocity is measured over the trailing 100 ms and projected 180 ms ahead to
decide between commit and snap-back. A committed card leaves along
x = x₀ + v₀t + ½at² with the duration set by its release speed (clamped to
100–240 ms), so a coast and a slow release both start at the speed the card
already had; that quadratic is expressed exactly as a `cubic-bezier`. A key or
button swipe has no hand speed, so it launches over 200 ms starting at half its
average speed rather than easing in from rest, which read as sluggish on
desktop. A snap-back is a damped spring (stiffness 400, damping 30)
carrying the release velocity, sampled into a `linear()` easing. The next card
waits fully drawn, slightly smaller and lower, and is uncovered rather than
faded in; it grows to full size with drag progress. All of this runs through
the Web Animations API with implicit end keyframes so a card can be caught
mid-flight. The stack shifts the moment a swipe commits; queued swipes are
written in one IndexedDB transaction so quick bursts never fall behind.

## 2026-09-26 — M2 theme concepts

Replace the RWG palette family (above) with complete design concepts, chosen
by a segmented control in Settings and still crossed with light/dark. The RWG
hard offset shadows and shared shapes did not suit this site, so each theme
now owns the whole contract: type, color, spacing, stroke, radius, and shadow
tokens live in `styles/themes/<id>.css`, and a theme may add a few structural
flourishes of its own. Three remain after review. **Gallery** (default) is
white on white: no borders, layered soft shadows, rounded rectangles, EB
Garamond for reading with Bricolage Grotesque for the word and all
informational text. **Nocturne** treats words as light: a midnight canvas
with a halo, glass cards with a sky-blue-to-violet gradient edge, the word in
Instrument Serif italic with a glow. **Indigo** treats the word as a diagram:
a cyanotype sheet over a dot grid, two small registration crosshairs on the
word card, the word in B612 Mono capitals measured by a dimension line, a
dashed callout for the definition. Five other concepts were built and cut in
review: Swiss (Helvetica, hairlines, one red), Bauhaus (Futura on colored
stock), Contour (a survey sheet with generated topographic contours), Preserve
(Fraunces, stitched edges, plum and marmalade), and Riso (two-ink overprint on
grainy paper). Fonts come from `@fontsource` latin subsets (10–80 KB per
file), so they ship in the precached shell and work offline. The theme name
is stored under the `theme` key in IndexedDB and `etymology-theme` in
localStorage; a light/dark value found there is the pre-picker preference and
is migrated to `colorMode`. `theme-color` comes from one map in
`lib/themes.ts`, passed to the pre-paint script with `define:vars`.

## 2026-09-27 — Card source link placement (§3, §7.4)

Keep one link per card to its Wiktionary entry, but move it from the word
heading to a quiet caption-voice link in the card footer beside the definition
toggle. CC BY-SA 4.0 §3(a)(1)(A)(v) asks for a link to the licensed material
where reasonably practicable, and Wikimedia's Terms of Use §7 treat a link to
the page as the accepted way to credit its authors, so the per-entry link
stays. §3(a)(2) lets attribution take any reasonable form for the medium, so
the heading itself need not be the link. The license and modification notices
remain in Settings. This supersedes the heading link chosen on 2026-09-26 for
the Feed card; the Liked list still links its headings.

## 2026-09-27 — Adopt the reviewed provenance-only exclusion rule (§4.1)

The editorial exclusion audit was accepted after the user found no further
false positives in the review sample. The full laughter etymology of **haha**
is an explicit positive regression: onomatopoeia explains an origin without
needing a quoted source meaning. Evaluate each etymology independently.

Classifier v2 excludes only fully parsed provenance with no explanation or
quoted meaning: language/form lists, borrowing and inheritance chains,
spelling variants, unglossed doublets/comparisons, and equivalent formulas.
Unrecognized syntax is retained under the existing eligibility rules. This is
not a blanket requirement for quotation marks or a length cutoff. All 30
supplied negative examples are regression fixtures in the upstream builder.

Display cleanup removes exact PIE root sidebars and bounded etymology trees,
while preserving surrounding prose and inline root explanations. The builder
rechecks eligibility and computes length bands and fresh priority from cleaned
text. Original source text and the original primary selection determine IDs;
no surviving card inherits the ID of a removed sibling. Raw dictionary text
and sense links are preserved.

The local rebuild in ignored `data/production-preview/` contains **111,396
cards**: the reviewed rule excludes 43,617 of the 155,032 baseline cards, and
19 more fail the existing eligibility gate after cleanup. The latter include
the malformed `necrovore`, which contains only “From” after its tree is removed;
its raw source remains available for later repair. The original audit and
400-card review set are preserved. Both Bluffs and the explanatory haha sense
survive. Classifier version and cleanup/exclusion counts are recorded in the
release metadata and report. No production release or deploy was performed.

Implementation is in the RWG source builder (`database/derive_etymology.py`,
`etymology_patterns.py`, `etymology_rules.py`, and `test_etymology*.py`), currently
in the local `/private/tmp/ef-rwg-work` checkout. Before M5, publish the rebuilt
source and derived assets under a new release tag and update the app's release
pin. The app fixture remains a historical integration fixture rather than a
representative sample of the new selection.

## 2026-09-27 — Adopt both second-round editorial filters (§4.1)

The user accepted the ordinary-provenance expansion and the separately reviewed
proper-noun rule. Classifier v3 adds learned borrowings, partial/full calques,
language/form fragments, bare references, singular-of pointers, romanizations,
surname variants, dated formulas, tribal-origin clauses, and noun/verb origin
statements. All clauses must be recognized; explanatory prose remains eligible.

For proper-noun-only cards, a quoted source meaning inside a lexical
parenthetical no longer rescues an otherwise bare origin. Both `def_pos` and
all paired POS must be proper nouns. Common-noun and mixed-POS cards retain
their gloss protection. This is per etymology, not per headword or capitalization.
The user accepted the audit after it explicitly highlighted potentially
interesting names such as Sahara, Mjollnir, and Columbiad. The scope therefore
includes such source-only name histories, not just surnames or place names.

The approved delta from the 111,396-card v2 preview is **8,848 exclusions**:
5,657 ordinary provenance entries and 3,191 glossed proper-noun origins. The
new local build is `data/production-preview-v3/`; v2 and both rounds of review
remain available unchanged. Release metadata records classifier version 3 and
separate exclusion counts. No schema migration or production deployment is
needed for this local data-selection change.

The source implementation adds `database/etymology_selection.py` in the RWG
checkout. The 19 new examples and positive cases are portable test fixtures;
the build test checks identical quoted origins with proper-only, common, and
mixed senses, plus stable IDs, definition pairing, cleanup, and SQL roundtrip.

## 2026-09-27 — Freeze the reviewed selection baseline (§4.1)

The user accepted the third exclusion audit and ended the editorial sampling
rounds. Classifier v4 recognizes qualified source attributions (ultimately,
possibly, via/through), language-led chains, romanizations, spelling/surname
variants, cf./More at references, formula alternatives, and Tibetan syllable
separators. These extend the accepted provenance grammar; the proper-noun-only
POS guard and explanatory-prose protections remain.

The final delta is **2,011 cards**: 1,572 plain provenance entries and 439
proper-name entries. The frozen local baseline has **100,537 cards**, down
54,495 (35.15%) from the original 155,032-card preview. All 62 supplied negative
texts are regression fixtures. Both Bluffs, the laughter and garden senses of
haha, and explanatory place-name stories remain. Source text and sense links
remain intact in the raw dictionary, and surviving card IDs are unchanged.

Stop prelaunch heuristic tuning here. The accepted rules, measurements,
verification, and remaining release work are recorded in `docs/DATA_SELECTION.md`.
This closes the editorial selection exercise; publishing the release and M5
production deployment remain separate work.


## 2026-09-27 — Own the feed data pipeline in Etymology Feed (§3.3, §4)

Supersede the earlier decision to derive and publish feed artifacts inside RWG.
This repo now owns `database/derive_etymology.py`, editorial rules, display
cleanup, stable card identity, priority, regression fixtures/tests, and feed
artifact releases. RWG continues owning full-source extraction, frequency
scoring, the source schema, and `dictionary.db` releases. No third repository
is needed to establish this boundary.

The consumer-owned `database/SOURCE.json` records the source repository, release
label, publication state, and SHA-256. Validate the checksum before producing
output and read the source database read-only. Until the compatible source is
published, the manifest explicitly identifies the reviewed local source as
unpublished; the older published dictionary lacks entry links and is unsuitable.
Tests create small source-contract fixtures with SQL and do not import RWG code.
RWG retains a separate source-entry-link regression without feed selection logic.

The move leaves classifier v4 and the 100,537-card baseline unchanged. Raw source
publication and feed artifact publication now have separate release steps.
Future editorial changes require only an Etymology Feed PR.


## 2026-09-28 — Production bootstrap and private recovery (§3.4, M5)

The owner chose Workers Paid to complete the initial import in one session.
Production has separate APP, immutable DICT, CACHE, and a private R2 bucket;
the scratch resources remain development targets. The reviewed source is now
published in RWG as dictionary-2026-09-28, without changing RWG's website pin.

Deployment reads the desired DICT binding from private R2 state, and app/release/
backup workflows share a concurrency group. Cache keys include the dictionary
release. CI covers Linux and macOS; native touch-selection coverage uses macOS.
The repository token passed a read-only check from GitHub Actions.

The first private backup restored every row correctly into isolated resources,
and guarded HTTP checks verified feed, session, and like operations. Temporary
resources were removed. RUNBOOK records the evidence and the limitation that
this snapshot preceded real user data. Public deployment, real OAuth checks,
and initial feed artifact publication remain pending PR review. Automatic
releases currently refuse removed card IDs until retired membership is modeled.


## 2026-09-28 — Preserve shared ratings through dictionary rollback (M5)

A failed dictionary release can leave new statistics in APP, and the candidate
Worker may already have accepted ratings. Keep those rows. Feed batches now
resolve their selected IDs against the active immutable DICT before filling
missing slots from its shuffle index. Cached candidates and served history from
other releases cannot imply dictionary exhaustion. Recovery scans are bounded
at 1,000 extra rows; normal complete-pool requests retain their existing cost.

The release coordinator also restores the previous pointer after ambiguous
pointer-write failures and gives every retry a unique DICT name. Local tests
inject failures at seed, pointer, deployment, and smoke-check boundaries, then
retry without resetting either old ratings or ratings received on the candidate.
The production smoke check now requires a full, distinct 100-card feed.


## 2026-09-28 — Final launch review (M5)

Require dictionary releases to pass the same app checks on the exact main SHA
that they deploy, and abort if main advances before the release starts. Health
reports the deployed app commit and dictionary release; smoke checks verify both,
with bounded retries for first-domain propagation and a full distinct feed.

Restore tools validate the guarded entrypoint, protection of every asset,
resource IDs (not just equality of config objects), and backup dictionary before
any import. Runtime tests cover rejected and authorized requests. Backups capture
actual deployed version metadata separately from the backup runner's checkout,
and whitelist nonsecret fields. Artifact checks also reject gaps in the shuffle
index or mismatched SQL/SQLite metadata. These are launch correctness changes;
no public deployment occurs before the reviewed merge.

The merged UI's synchronous card preview stays display-only until IndexedDB
confirms the saved stack. A delayed-storage browser regression verifies that a
stale preview cannot receive a swipe. Account fixtures update both preview and
saved cards, then wait for the intended card to become interactive.

## 2026-09-28 — Proper nouns are an opt-in feed preference

Add **Include proper nouns** to desktop and mobile Settings, off by default and
stored on the device. Use the paired definition's part of speech, so common-word
senses remain eligible even when the headword is capitalized or also has a name
sense. Keep the full dictionary, card IDs, ratings, and Liked history unchanged.
Retain hidden unswiped cards in IndexedDB so enabling the preference also works
offline. Apply the preference to every server feed path, including cached lane
candidates and fallback draws, and send it explicitly on new fetches. Filtering
can require additional indexed reads; measure production usage before claiming
the original unfiltered 101-row estimate for default feed requests.


## 2026-09-28 — Randomize pool ties before selection, preserve filtered slots

A read-only production cache inspection found 79 suffixes among 226 eligible
cards in the first 1,000 fresh candidates; the other 774 were proper nouns.
The pool indexes implicitly broke equal-priority ties by card ID, putting
hyphen-prefixed suffixes and capitalized names first. Shuffling this head after
the cutoff could not remove its bias. Filtering then compacted surviving picks
and appended replacements, concentrating the biased picks at the front.

Assign each statistics row an independent `pool_order` using SQLite's random
blob default, and index it after the existing lane priorities. Apply that order
explicitly before every pool limit. Keep the fresh lane's 1,000-card head and
per-request shuffle, rating formulas, and lane quotas unchanged. Preserve empty
slots through dictionary resolution and ranked-lane retries, then fill remaining
gaps in place from bounded wild recovery, including stale IDs and exhausted
lanes. Bucket labels still report the actual source of each card.

Migration `0001_random_pool_ties` rebuilds only `word_stats`, retains its
WITHOUT ROWID layout and all six existing values, assigns tie keys to existing
rows, and recreates its indexes. New dictionary seeds receive keys from the
default; conflict retries and ratings retain them. No per-refresh random sort
or additional index is needed. Cache keys advance to `pools:v4:<DICT_RELEASE>`
so an old biased pool cannot survive deployment. The reporting tool accepts
both six-column historical exports and seven-column current exports.

Local validation applied the migration to all 100,537 release statistics rows:
all original values were identical afterward and integrity passed. One random
replay reduced suffixes in the first 1,000 fresh candidates from 120 to 13
(proper nouns from 712 to 139); exact counts vary with assigned keys. Query plans
remain indexed without a temporary sort. Existing offline stacks retain their
already downloaded cards; the change affects newly fetched batches. Production
migration/deployment is separate from this local validation.

## 2026-09-28 — Preserve sibling identity and ranked slots when filtering

A hidden proper-noun etymology can share its headword with a visible common-word
card. Swipe persistence must compare explicit card IDs; normalize only old records
without IDs to their legacy headword identity. Otherwise a swipe can remove the
hidden sibling and leave the swiped card in the stack. Browser regressions cover
both stored ID formats and restoring the hidden sibling through Settings.

Filtering a ranked candidate now retries its slot from the same lane before
normal fill-through, preserving the feed mix and the actual source bucket. Batch
primary-key lookups and a 500-candidate limit bound this work per attempt. At the
limit, existing bounded shuffle recovery keeps name-heavy or stale ranked pools
from blocking the feed and preserves dictionary rollback behavior. Filtered and
missing IDs never enter served history. Tests cover lane proportions, no repeats,
read costs, the limit, and existing rollback recovery.


## 2026-09-29 — Reduce duplicate CI and stabilize browser fixtures

Run the complete suite on Linux and only the native-touch selection case on
macOS. Keep existing check names and deployment/release gates. Remove the
standalone main-push trigger because Deploy production already invokes the same
checks. Reuse Chrome after a real launch probe, and seed the small APP fixture in
one statement instead of starting Wrangler six times.

Keep browser coverage for persistence, offline operation, identity, accounts, and
real input. Drop decorative/demo checks and duplicate animation assertions; wire
the existing swipe and text-selection unit tests into CI. Seed decks only after
leaving the active Feed and intercept service-worker requests at context scope.
Retain failure traces and screenshots rather than enabling automatic retries. See
TESTING.md for commands, coverage, the measured baseline, and fixture rules.
