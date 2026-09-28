# Feed dictionary pipeline

This directory owns Etymology Feed's transformation of a full dictionary into
sense-matched feed cards. RWG owns the full-source ingestion and schema;
no RWG checkout or Python imports are required here. Python 3.11+ is sufficient.

`SOURCE.json` pins the full source's repository, release, SHA-256, and publication
state. The current pin is the reviewed local source (`published: false`), not a
published release. The old `dictionary-2026-09-20b` asset lacks source-entry links.
A compatible full source must be published in RWG before production release.

From this repository's root:

```sh
npm run test:dictionary
python3 database/derive_etymology.py --source data/multi-etymology-preview/dictionary.db
python3 database/derive_etymology.py --source data/multi-etymology-preview/dictionary.db --check
```

The build checks the pinned checksum before creating output and reads the source
SQLite database read-only. Outputs default to gitignored `data/dictionary/`:
`etymology.db`, `etymology.sql`, and `etymology-report.txt`. The default source path
is `data/source/dictionary.db`. Use `--output-dir` for a different output folder;
use `--source-manifest` to choose a different explicit source pin. Threshold
flags remain `--story-min-length` and `--pointer-max-length`.

Once RWG publishes a compatible source, download its **dictionary.db** asset to
`data/source/`, update SOURCE.json with that release, its verified SHA-256, and
`published: true`, and build/check here. Changing a pin is a reviewed code change.
Publish the three derived artifacts on this repo's own feed release, with the
source provenance preserved in the database metadata and report. A feed-only
filter change can reuse the same source release; it needs no RWG code change.

The accepted classifier is v4: 100,537 cards across 95,841 headwords. See
[the rules, measurements, and release handoff](../docs/DATA_SELECTION.md).
`etymology-selection-audit.json` preserves the reviewed source checksum and counts.
Tests cover all 62 supplied negatives, positive explanations, identity, paired
senses, cleanup, POS guards, SQL export, and source pins. `source_fixture.py`
contains only a small test input contract, not a copy of RWG's source builder.

The original Wiktionary text is CC BY-SA 4.0 via kaikki.org. Full source and
artifact databases are never committed; small editorial fixtures are retained
with that attribution.
