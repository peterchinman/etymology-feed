#!/usr/bin/env python3
"""Build the feed dictionary from a checksum-pinned full source dictionary.

    python3 database/derive_etymology.py --source data/source/dictionary.db
    python3 database/derive_etymology.py --source data/source/dictionary.db --check

Only the standard library is required. Outputs are release assets, never git files.
"""

import argparse
import hashlib
import json
import random
import re
import sqlite3
import time
from collections import Counter
from pathlib import Path

from etymology_patterns import LANGUAGE_NAMES, MORPH_RE
from etymology_rules import clean_display, provenance
from etymology_selection import exclusion_reason

HERE = Path(__file__).resolve().parent
SCHEMA_VERSION = "2"
CLASSIFIER_VERSION = "4"
SEED = 20260925
SHAPES = (
    "multiword", "capitalized", "hyphenated", "apostrophe", "nonascii",
    "digits", "pointer_only",
)
TIER_ORDER = (
    "common", "uncommon", "scarce", "rare", "obscure", "marginal", "unattested",
)
POINTER_STARTS = (
    "Clipping", "Abbreviation", "Initialism", "Acronym", "Shortening",
    "Short for", "Alteration", "Alternative form", "Variant", "Diminutive",
    "Plural", "Back-formation", "Blend", "Contraction", "Ellipsis",
    "Pronunciation spelling", "Eye dialect", "Misspelling", "Compound",
    "Univerbation", "Hypocoristic", "Reduplication", "Doublet",
)
POINTER_RE = re.compile(r"^(?:" + "|".join(re.escape(s) for s in POINTER_STARTS) + r")\b", re.I)

LANGUAGE_RE = re.compile(
    r"(?<!\w)(?:" + "|".join(re.escape(s) for s in sorted(LANGUAGE_NAMES, key=len, reverse=True))
    + r"|Proto-[A-Za-z-]+)(?!\w)", re.I,
)
GLOSS_RE = re.compile(r'[“\"][^”\"\n]+[”\"]')
PRIOR_TERMS = (
    "doublet", "cognate", "folk etymology", "originally", "literally",
    "borrow", "named after", "coined",
)

CREATE_SQL = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE word (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  etym_no INTEGER,
  ipa TEXT,
  tier TEXT NOT NULL,
  zipf REAL,
  shape TEXT NOT NULL,
  pos TEXT NOT NULL,
  definition TEXT NOT NULL,
  def_pos TEXT NOT NULL,
  etymology TEXT NOT NULL,
  etym_len INTEGER NOT NULL,
  etym_band TEXT NOT NULL,
  has_signal INTEGER NOT NULL,
  prior REAL NOT NULL,
  shuffle INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_word_shuffle ON word(shuffle);
CREATE INDEX idx_word_prior ON word(prior DESC);
CREATE INDEX idx_word_headword ON word(word,etym_no);
"""
WORD_COLUMNS = (
    "id", "word", "etym_no", "ipa", "tier", "zipf", "shape", "pos", "definition", "def_pos",
    "etymology", "etym_len", "etym_band", "has_signal", "prior", "shuffle",
)


class Reservoir:
    def __init__(self, size, seed):
        self.size = size
        self.random = random.Random(seed)
        self.seen = 0
        self.values = []

    def add(self, value):
        self.seen += 1
        if len(self.values) < self.size:
            self.values.append(value)
        else:
            pick = self.random.randrange(self.seen)
            if pick < self.size:
                self.values[pick] = value


def classify(text, pointer_max_length):
    if MORPH_RE.fullmatch(text.strip()):
        return "morph"
    if len(text) < pointer_max_length and POINTER_RE.match(text.strip()):
        return "pointer"
    return "story"


def signals(text):
    names = {match.group().lower() for match in LANGUAGE_RE.finditer(text)}
    return names, bool(names or GLOSS_RE.search(text))


def band(length):
    if length < 40:
        return "lt40"
    if length < 80:
        return "40_80"
    if length < 120:
        return "80_120"
    if length < 200:
        return "120_200"
    return "200plus"


def prior(text, tier, names):
    length = len(text)
    length_bonus = (-0.1 if length < 40 else 0 if length < 80 else
                    0.1 if length < 120 else 0.2 if length < 250 else 0.25)
    terms = sum(term in text.lower() for term in PRIOR_TERMS)
    tier_bonus = 0.05 if tier in ("common", "uncommon") else -0.05 if tier in ("marginal", "unattested") else 0
    value = 0.4 + length_bonus + min(len(names) * 0.05, 0.2) + min(terms * 0.04, 0.15) + tier_bonus
    return round(max(0.2, min(0.8, value)), 4)


def meanings(source, word_id, entry_nos):
    rows = source.execute(
        "SELECT m.entry_no, p.name, m.kind, m.definition, m.demoted FROM meaning m "
        "JOIN pos p ON p.code=m.pos WHERE m.word_id=? ORDER BY m.ord", (word_id,),
    ).fetchall()
    rows = [row for row in rows if row[0] in entry_nos]
    if not rows:
        return "[]", "", ""
    parts = list(dict.fromkeys(row[1] for row in rows))
    chosen = next((row for row in rows if row[2] == "definition" and not row[4]), None)
    chosen = chosen or next((row for row in rows if row[2] == "definition"), rows[0])
    return json.dumps(parts, ensure_ascii=False), chosen[3], chosen[1]


def pronunciation(source, word_id, entry_nos, fallback):
    rows = source.execute(
        "SELECT entry_no,ipa,tags FROM pronunciation WHERE word_id=?", (word_id,)
    )
    candidates = []
    for entry_no, ipa, tags_json in rows:
        if entry_no not in entry_nos:
            continue
        tags = set(json.loads(tags_json))
        rank = (3 if tags & {"General-American", "US"} else
                2 if tags & {"Received-Pronunciation", "UK"} else
                1 if not tags else 0)
        candidates.append((rank + (0.5 if ipa.startswith("/") else 0), ipa))
    return max(candidates, key=lambda item: item[0])[1] if candidates else fallback


def card_id(word, etym_no, text, legacy):
    if legacy:
        return word  # Keeps ratings and local served history for the old primary card.
    digest = hashlib.sha256(json.dumps([word, etym_no, text], ensure_ascii=False).encode()).hexdigest()
    return "e:" + digest


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    if "\x00" in value:
        return "CAST(X'" + value.encode("utf-8").hex() + "' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def write_sql(db, path):
    """Keep each INSERT at <=100 rows and <100 KB, the D1 statement limits."""
    prefix = "INSERT INTO word (" + ",".join(WORD_COLUMNS) + ") VALUES\n"
    with path.open("w", encoding="utf-8") as out:
        out.write("-- Derived from the release in meta.source_release; generated, do not edit.\n")
        out.write(CREATE_SQL)
        meta = db.execute("SELECT key,value FROM meta ORDER BY key")
        for key, value in meta:
            out.write("INSERT INTO meta VALUES (" + sql_literal(key) + "," + sql_literal(value) + ");\n")
        batch = []
        size = len(prefix.encode("utf-8"))
        for row in db.execute("SELECT " + ",".join(WORD_COLUMNS) + " FROM word ORDER BY shuffle"):
            item = "(" + ",".join(sql_literal(value) for value in row) + ")"
            item_size = len(item.encode("utf-8")) + 2
            if batch and (len(batch) == 100 or size + item_size > 99_000):
                out.write(prefix + ",\n".join(batch) + ";\n")
                batch, size = [], len(prefix.encode("utf-8"))
            if item_size + size > 99_000:
                raise ValueError(f"One card exceeds D1's 100 KB statement limit: {row[0]}")
            batch.append(item)
            size += item_size
        if batch:
            out.write(prefix + ",\n".join(batch) + ";\n")


def sample_lines(title, values):
    return [title] + [f"  {word}: {text}" for word, text in values] + [""]


def source_metadata(args):
    """Validate the consumer-owned source pin before creating any output."""
    pin = json.loads(args.source_manifest.read_text())
    if (not isinstance(pin.get("repository"), str) or not pin["repository"]
            or not isinstance(pin.get("release"), str) or not pin["release"]
            or not isinstance(pin.get("published"), bool)
            or not isinstance(pin.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", pin["sha256"])):
        raise ValueError("source manifest requires repository, release, published, and SHA-256")
    with args.source.open("rb") as source_file:
        checksum = hashlib.file_digest(source_file, "sha256").hexdigest()
    if checksum != pin["sha256"]:
        raise ValueError(f"source checksum mismatch: {checksum} != {pin['sha256']}")
    return {
        "source_repository": pin["repository"],
        "source_release": pin["release"],
        "source_sha256": checksum,
        "source_published": str(pin["published"]).lower(),
    }


def build(args):
    source_info = source_metadata(args)
    source = sqlite3.connect(args.source.resolve().as_uri() + "?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    release = source_info["source_release"]
    columns = {row[1] for row in source.execute("PRAGMA table_info(etymology)")}
    meaning_columns = {row[1] for row in source.execute("PRAGMA table_info(meaning)")}
    pronunciation_columns = {row[1] for row in source.execute("PRAGMA table_info(pronunciation)")}
    if "entry_no" not in columns or "entry_no" not in meaning_columns or "entry_no" not in pronunciation_columns:
        source.close()
        raise ValueError("source dictionary predates sense-to-etymology links; use a rebuilt full dictionary from RWG")
    output = args.output_dir
    output.mkdir(parents=True, exist_ok=True)
    db_path = output / "etymology.db"
    temp = output / "etymology.db.tmp"
    temp.unlink(missing_ok=True)
    db = sqlite3.connect(temp)
    db.executescript(CREATE_SQL)
    counts, tiers, shapes, bands = Counter(), Counter(), Counter(), Counter()
    excluded_sample = Reservoir(25, SEED + 5)
    cleanup_sample = Reservoir(25, SEED + 6)
    selection_counts = Counter()
    morph_sample = Reservoir(25, SEED + 1)
    short_sample = Reservoir(25, SEED + 2)
    etymologies = iter(source.execute(
        "SELECT word_id,entry_no,etym_no,text FROM etymology ORDER BY word_id,id"
    ))
    current = next(etymologies, None)
    kept = []
    started = time.monotonic()
    for word in source.execute("SELECT * FROM word ORDER BY id"):
        groups = {}
        while current is not None and current[0] == word["id"]:
            key = (current[2], current[3])
            groups.setdefault(key, set()).add(current[1])
            current = next(etymologies, None)
        if not groups:
            continue
        shape = ",".join(flag for flag in SHAPES if word[flag]) or "plain"
        selected = []
        for (etym_no, text), entry_nos in groups.items():
            kind = classify(text, args.pointer_max_length)
            counts[kind] += 1
            if kind == "morph":
                morph_sample.add((word["word"], text))
            if kind == "story" and len(text) < 40:
                short_sample.add((word["word"], text))
            names, has_signal = signals(text)
            if kind != "story" or not (len(text) >= args.story_min_length or has_signal):
                continue
            pos, definition, def_pos = meanings(source, word["id"], entry_nos)
            if not definition:
                counts["eligible without paired definition"] += 1
                continue
            score = prior(text, word["tier"], names)
            ipa = pronunciation(source, word["id"], entry_nos, word["ipa"])
            selected.append((etym_no, text, ipa, pos, definition, def_pos, score, has_signal))
        if not selected:
            continue
        # Choose the legacy primary from the original eligible texts, before
        # cleanup/filtering. Never transfer its ID to a surviving sibling.
        legacy_key = max(selected, key=lambda item: len(item[1]))[:2]
        for etym_no, original, ipa, pos, definition, def_pos, score, has_signal in selected:
            identity = card_id(word["word"], etym_no, original,
                               (etym_no, original) == legacy_key)
            text, removed = clean_display(original, word["word"])
            if removed:
                selection_counts["display_cleaned"] += 1
                cleanup_sample.add((word["word"], text))
            reason = provenance(text)
            if reason:
                selection_counts[reason] += 1
                excluded_sample.add((word["word"], text))
                continue
            # Sidebar text must not inflate eligibility, bands, or fresh priority.
            names, has_signal = signals(text)
            kind = classify(text, args.pointer_max_length)
            if kind != "story" or not (len(text) >= args.story_min_length or has_signal):
                selection_counts["ineligible_after_cleanup"] += 1
                continue
            # POS belongs to this etymology's source entries, not the headword.
            reason = exclusion_reason({"etymology": text, "pos": pos, "def_pos": def_pos})
            if reason:
                selection_counts[reason] += 1
                excluded_sample.add((word["word"], text))
                continue
            score = prior(text, word["tier"], names)
            kept.append((identity,
                         word["word"], etym_no, ipa, word["tier"], word["zipf"], shape,
                         pos, definition, def_pos, text, len(text), band(len(text)),
                         int(has_signal), score))
            tiers[word["tier"]] += 1
            bands[band(len(text))] += 1
            for flag in shape.split(","):
                shapes[flag] += 1
    rng = random.Random(SEED)
    shuffles = list(range(1, len(kept) + 1))
    rng.shuffle(shuffles)
    with db:
        db.executemany(
            "INSERT INTO word VALUES (" + ",".join("?" for _ in WORD_COLUMNS) + ")",
            (row + (shuffle,) for row, shuffle in zip(kept, shuffles)),
        )
        metadata = {
            **source_info,
            "source_file": args.source.name,
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "story_min_length": str(args.story_min_length),
            "pointer_max_length": str(args.pointer_max_length),
            "classifier_version": CLASSIFIER_VERSION,
            "schema_version": SCHEMA_VERSION,
            "selection_counts": json.dumps(selection_counts, sort_keys=True),
            "row_count": str(len(kept)),
            "tier_histogram": json.dumps(tiers, sort_keys=True),
            "shape_histogram": json.dumps(shapes, sort_keys=True),
            "band_histogram": json.dumps(bands, sort_keys=True),
        }
        db.executemany("INSERT INTO meta VALUES (?,?)", metadata.items())
    db.close()
    temp.replace(db_path)
    db = sqlite3.connect(db_path)
    write_sql(db, output / "etymology.sql")
    decile = max(1, len(kept) // 10)
    top = Reservoir(20, SEED + 3)
    bottom = Reservoir(20, SEED + 4)
    for word, text in db.execute("SELECT word,etymology FROM word ORDER BY prior DESC LIMIT ?", (decile,)):
        top.add((word, text))
    for word, text in db.execute("SELECT word,etymology FROM word ORDER BY prior ASC LIMIT ?", (decile,)):
        bottom.add((word, text))
    lines = [
        f"Source release: {release}", f"Source repository: {source_info['source_repository']}",
        f"Source SHA-256: {source_info['source_sha256']}",
        f"Source published: {source_info['source_published']}", f"Source dictionary: {args.source}",
        f"Selected cards: {len(kept):,}; distinct words: {len({row[1] for row in kept}):,}",
        f"Thresholds: story_min_length={args.story_min_length}, pointer_max_length={args.pointer_max_length}",
        f"Classifier version: {CLASSIFIER_VERSION}",
        f"Elapsed seconds: {time.monotonic() - started:.1f}",
        f"Classes (original source): {json.dumps(counts, sort_keys=True)}",
        f"Selection audit (original eligible cards): {json.dumps(selection_counts, sort_keys=True)}",
        f"Tiers: {json.dumps(tiers, sort_keys=True)}",
        f"Shapes (overlapping): {json.dumps(shapes, sort_keys=True)}",
        f"Bands: {json.dumps(bands, sort_keys=True)}", "",
        "Prior range: [0.2, 0.8] (orders fresh cards only)", "",
    ]
    lines += sample_lines("25 random provenance exclusions", excluded_sample.values)
    lines += sample_lines("25 random cleaned etymologies", cleanup_sample.values)
    lines += sample_lines("25 random morph classifications", morph_sample.values)
    lines += sample_lines("25 random story entries under 40 characters", short_sample.values)
    lines += sample_lines("20 random words from top prior decile", top.values)
    lines += sample_lines("20 random words from bottom prior decile", bottom.values)
    (output / "etymology-report.txt").write_text("\n".join(lines), encoding="utf-8")
    db.close()
    source.close()
    print(f"Selected {len(kept):,} cards from {release} in {time.monotonic() - started:.1f}s")
    print(f"Wrote {db_path}, {output / 'etymology.sql'}, {output / 'etymology-report.txt'}")


def check(args):
    source_info = source_metadata(args)
    examples = {
        "From di- + keto acid.": "morph",
        "From clerk + -ship. See clerk.": "morph",
        "From clerk + -ship, after an Old French word.": "story",
    }
    for text, expected in examples.items():
        if classify(text, args.pointer_max_length) != expected:
            raise AssertionError(f"classifier failed: {text}")
    db = sqlite3.connect((args.output_dir / "etymology.db").resolve().as_uri() + "?mode=ro", uri=True)
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise AssertionError(f"integrity_check: {integrity}")
    count = db.execute("SELECT count(*) FROM word").fetchone()[0]
    if not 100_000 <= count <= 350_000:
        raise AssertionError(f"expected 100k–350k cards, got {count}")
    minimum, maximum = db.execute("SELECT min(prior),max(prior) FROM word").fetchone()
    if minimum < 0.2 or maximum > 0.8:
        raise AssertionError(f"prior out of range: [{minimum}, {maximum}]")
    db.execute("ATTACH DATABASE ? AS source", (args.source.resolve().as_uri() + "?mode=ro",))
    missing = db.execute(
        "SELECT w.word FROM word w WHERE NOT EXISTS "
        "(SELECT 1 FROM source.word s WHERE s.word=w.word) LIMIT 1"
    ).fetchone()
    if missing:
        raise AssertionError(f"word absent from source: {missing[0]}")
    release = source_info["source_release"]
    recorded = dict(db.execute("SELECT key,value FROM meta"))
    for key, value in source_info.items():
        if recorded.get(key) != value:
            raise AssertionError(f"{key} mismatch: {recorded.get(key)} != {value}")
    print(f"Integrity: {integrity}; rows: {count:,}; prior: [{minimum}, {maximum}]; source membership: complete; release: {release}")
    print("10 random rendered cards:")
    for word, ipa, pos, definition, etymology in db.execute(
        "SELECT word,ipa,pos,definition,etymology FROM word ORDER BY random() LIMIT 10"
    ):
        print(f"\n{word} {ipa or ''} · {', '.join(json.loads(pos))}\n{etymology}\n{definition}")
    db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=HERE.parent / "data/source/dictionary.db")
    parser.add_argument("--source-manifest", type=Path, default=HERE / "SOURCE.json")
    parser.add_argument("--output-dir", type=Path, default=HERE.parent / "data/dictionary")
    parser.add_argument("--story-min-length", type=int, default=80)
    parser.add_argument("--pointer-max-length", type=int, default=70)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error(f"missing source dictionary: {args.source}")
    if args.check:
        check(args)
    else:
        build(args)


if __name__ == "__main__":
    main()
