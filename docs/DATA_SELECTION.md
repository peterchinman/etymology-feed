# Accepted dictionary selection baseline

Editorial review is complete for prelaunch. Three rounds of 400 retained cards,
followed by exclusion audits, established classifier **v4**: **100,537 cards
across 95,841 headwords**. The full local build lives in the ignored
`data/production-baseline/` directory. Raw source data and all previous review
sets remain available. The initial release is published and production is live;
see [RUNBOOK.md](RUNBOOK.md) for launch evidence.

**Feed preference:** Settings offers **Include proper nouns**, off by default.
The API excludes cards whose paired definition is `proper noun` unless explicitly
enabled. This hides 21,314 cards in the v4 release, leaving 79,223 eligible by
default. It does not change the dictionary selection baseline or remove data:
turning it on restores eligibility, and existing likes remain available. Mixed
POS cards follow their displayed definition; capitalization is not a filter.

## Selection rules

Evaluate each source etymology with definitions/POS from its own source entries.
Keep the existing story/length/signal gate and paired-definition requirement.
All tiers and word shapes remain eligible.

Exclude a text when all its clauses are recognized as origins without an
explanation: language/form lists, borrowing/inheritance/calque chains,
romanizations, spelling/surname variants, equivalent formulas, comparisons,
doublets, and bare references. Recognized qualifications such as “ultimately”
or “possibly” do not rescue a source-only chain. Tibetan syllable separators
are accepted in lexical forms. Unknown syntax remains eligible under the gate.

Quoted source meanings protect ordinary cards from this additional filter.
For **proper-noun-only** cards, meanings inside lexical parentheticals do not
rescue an otherwise bare origin. Both the chosen definition's POS and all
paired POS must be proper nouns; capitalization and unrelated senses do not
control the decision. Mixed proper/common-noun cards stay protected. The user
accepted this tradeoff after reviewing meaningful name origins as well as
simple surnames. Narrative quotations, naming anecdotes, meaning changes,
onomatopoeia, and other explanatory prose still remain eligible.

Remove exact “PIE word” root panels and bounded “Etymology tree” blocks before
final eligibility, length-band, and priority calculations. Preserve inline
roots and surrounding prose; leave unbounded/malformed blocks for review.
Gloss removal for classification never changes displayed text. Original source
text and the original primary selection determine card identity, so excluding
a primary never transfers its ID to a surviving sibling.

## Measurements

| Stage | Newly excluded | Remaining cards |
| --- | ---: | ---: |
| Initial multi-etymology preview | — | 155,032 |
| Round 1: bare provenance | 43,617 | 111,415 |
| Eligibility after tree/root cleanup | 19 | 111,396 |
| Round 2: broader origin syntax | 5,657 | 105,739 |
| Round 2: glossed proper-name origins | 3,191 | 102,548 |
| Round 3: additional origin syntax | 1,572 | 100,976 |
| Round 3: additional proper-name origins | 439 | **100,537** |

Total reduction: **54,495 cards (35.15%)**. These are counts on one fixed source,
not estimates of universal classifier accuracy. Each retained-card review used
200 uniform random cards plus length, high-priority, and multi-origin coverage.
Later samples excluded previously shown headwords. Exclusion reviews included
random, long, common, and supplied examples. Combined review proportions are
not corpus estimates. The malformed tree-only `necrovore` leaves only “From”
and fails eligibility; its original text remains available for source repair.

## Validation and implementation

This repository owns `database/derive_etymology.py`, `etymology_patterns.py`,
`etymology_rules.py`, and `etymology_selection.py`. The release metadata records
classifier v4, thresholds, counts by exclusion reason, and cleaned-text bands.
`database/etymology-selection-audit.json` records this baseline and source hash.
The 62 supplied negative texts and positive sense fixtures are checked into
this repository; the full data artifacts are not.

Twenty portable tests cover examples from all three rounds, explanations
without glosses, proper/common/mixed POS, sense pairing, stable IDs, cleanup,
SQL export, and checksum pinning. No test imports RWG code or requires an RWG checkout. A dedicated CI workflow runs them on dictionary changes.
The full local rebuild also passes integrity/source-membership checks and a
complete SQL roundtrip. Its surviving cards exactly match v3 minus the approved
2,011 exclusions; all surviving fields except shuffle position are unchanged.
Both Bluffs, the laughter and garden senses of haha, and explanatory place-name
histories are retained. Local verification is in
`data/production-baseline/verification.json` and `verify.py`.

In this checkout, reproduce the builder/tests with:

```sh
python3 -m unittest discover -s database -p 'test_*.py' -v
python3 database/derive_etymology.py --source /path/to/rebuilt/dictionary.db --output-dir /path/to/output
python3 database/derive_etymology.py --source /path/to/rebuilt/dictionary.db --output-dir /path/to/output --check
```

`database/SOURCE.json` pins the full source repository, release label, and
SHA-256. The reviewed source is now published as `dictionary-2026-09-28`.
The builder validates that hash and opens the
input read-only. Use `--source-manifest` to select a different explicit pin.
The input must contain source-entry links; the published old release cannot
replace the rebuilt local source. The local `data/feed-owned-preview/` rebuild
from this repo has exactly the same card rows as the frozen baseline; metadata
additionally records the source repository, checksum, and publication state.

## Release handoff

1. Merge the feed-pipeline move here and the RWG cleanup PR. The application
   owns all editorial selection from this point onward.
2. In RWG, publish the rebuilt full `dictionary.db` with entry links under a new
   source release tag. RWG retains ingestion, frequency enrichment, its full
   schema, and its website's independent release pin.
3. Update this repo's `database/SOURCE.json` to that published source and verified
   checksum, then rebuild/check the feed. Publish `etymology.db`, `etymology.sql`,
   and the report as a separate **Etymology Feed** release. Editorial filter
   changes need only this repo and can reuse the same pinned full source.
4. In M5, import the feed release into a fresh DICT database and seed APP stats
   using retained card IDs. The existing app fixture remains historical
   integration data, not the production dictionary or a representative sample.

Selection review is closed for now. Revisit heuristics when new editorial or
usage evidence justifies a change; do not hold production preparation on
further speculative pattern hunting.
