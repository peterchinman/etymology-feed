"""Production operations. All remote commands use explicit production bindings."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "apps/api/wrangler.production.json"
RUNTIME = ROOT / "apps/api/.wrangler.production-runtime.json"
WRANGLER = ROOT / "node_modules/.bin/wrangler"
BUCKET = "etymology-feed-backups"
STATE = f"{BUCKET}/production/dictionary.json"


def run(*args, capture=False):
    result = subprocess.run([str(a) for a in args], cwd=ROOT, check=True,
                            text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else None


def wrangler(*args, config=RUNTIME, capture=False):
    return run(WRANGLER, *args, "--config", config, capture=capture)


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def prepare(directory):
    directory = Path(directory)
    db = sqlite3.connect(f"{(directory / 'etymology.db').resolve().as_uri()}?mode=ro", uri=True)
    meta = dict(db.execute("SELECT key,value FROM meta"))
    if meta.get("source_published") != "true":
        raise ValueError("Publish the pinned full source before a production release")
    rows = db.execute("SELECT id,prior FROM word ORDER BY shuffle").fetchall()
    if len(rows) != int(meta["row_count"]) or db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("Invalid dictionary")
    # This is idempotent. Existing user ratings are never reset by a release.
    with (directory / "word-stats.sql").open("w") as f:
        for start in range(0, len(rows), 100):
            values = ",".join(f"({quote(card)},0,0,{float(prior)},0.5,0)"
                              for card, prior in rows[start:start+100])
            f.write("INSERT INTO word_stats(card_id,likes,dislikes,prior,score,updated_at) VALUES "
                    + values + " ON CONFLICT(card_id) DO NOTHING;\n")
    db.close()
    files = ["etymology.db", "etymology.sql", "etymology-report.txt", "word-stats.sql"]
    manifest = {"row_count": len(rows), "source": meta,
                "sha256": {name: digest(directory / name) for name in files}}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared release: {len(rows)} cards")


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    required = {"etymology.db", "etymology.sql", "etymology-report.txt", "word-stats.sql"}
    if set(manifest["sha256"]) != required:
        raise ValueError("Release asset set does not match")
    for name, expected in manifest["sha256"].items():
        if digest(directory / name) != expected:
            raise ValueError(f"Checksum mismatch: {name}")
    db = sqlite3.connect(":memory:")
    db.executescript((directory / "etymology.sql").read_text())
    count = db.execute("SELECT count(*) FROM word").fetchone()[0]
    meta = dict(db.execute("SELECT key,value FROM meta"))
    if count != manifest["row_count"] or meta != manifest["source"] or meta.get("source_published") != "true":
        raise ValueError("Release provenance/count mismatch")
    local = sqlite3.connect(f"{(directory / 'etymology.db').resolve().as_uri()}?mode=ro", uri=True)
    if db.execute("SELECT * FROM word ORDER BY id").fetchall() != local.execute("SELECT * FROM word ORDER BY id").fetchall():
        raise ValueError("SQL and SQLite cards differ")
    local.close()
    db.close()
    # Validate the seed contents against the checked dictionary, rather than
    # trusting only the manifest's checksum for a second SQL asset.
    seed = sqlite3.connect(":memory:")
    seed.executescript("CREATE TABLE word_stats(card_id TEXT PRIMARY KEY,likes INTEGER,dislikes INTEGER,prior REAL,score REAL,updated_at INTEGER);")
    seed.executescript((directory / "word-stats.sql").read_text())
    source = sqlite3.connect(f"{(directory / 'etymology.db').resolve().as_uri()}?mode=ro", uri=True)
    wanted = [(card, 0, 0, prior, 0.5, 0) for card, prior in source.execute("SELECT id,prior FROM word ORDER BY id")]
    if seed.execute("SELECT * FROM word_stats ORDER BY card_id").fetchall() != wanted:
        raise ValueError("Seed does not match dictionary")
    source.close()
    seed.close()
    return manifest


def render():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "dictionary.json"
        wrangler("r2", "object", "get", STATE, "--remote", "--file", path, config=CONFIG)
        state = json.loads(path.read_text())
    if not re.fullmatch(r"[0-9a-f-]{36}", state["database_id"]):
        raise ValueError("Invalid production dictionary ID")
    cfg = json.loads(CONFIG.read_text())
    cfg["d1_databases"][0] = {"binding": "DICT", "database_id": state["database_id"],
                              "database_name": state["database_name"]}
    cfg["vars"]["DICT_RELEASE"] = state["release"]
    RUNTIME.write_text(json.dumps(cfg, indent=2) + "\n")
    return cfg, state


def save_state(state):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "dictionary.json"
        path.write_text(json.dumps(state, indent=2) + "\n")
        wrangler("r2", "object", "put", STATE, "--remote", "--file", path, config=CONFIG)


def deploy():
    render()
    wrangler("d1", "migrations", "apply", "APP", "--remote")
    wrangler("deploy")
    run("node", "scripts/smoke-production.mjs", "https://etymologyfeed.com")


def release(tag):
    if not re.fullmatch(r"feed-[a-zA-Z0-9.-]+", tag):
        raise ValueError("Expected a feed-* release tag")
    cfg, previous = render()
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        run("gh", "release", "download", tag, "--repo", "peterchinman/etymology-feed",
            "--dir", directory, "--pattern", "etymology.*", "--pattern", "etymology-report.txt",
            "--pattern", "word-stats.sql", "--pattern", "manifest.json")
        manifest = verify(directory)
        if previous["release"] == tag:
            print("Dictionary already selected; retrying deployment")
            deploy()
            return
        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        name = f"etymology-feed-dict-{suffix}"
        created = wrangler("d1", "create", name, "--location", "enam", "--update-config=false", capture=True)
        match = re.search(r'"database_id":\s*"([0-9a-f-]+)"', created)
        if not match:
            raise ValueError("Could not identify created dictionary; inspect D1 before retrying")
        candidate = {"database_name": name, "database_id": match[1], "release": tag}
        cfg["d1_databases"][0] = {"binding": "DICT", **{k: candidate[k] for k in ("database_name", "database_id")}}
        cfg["vars"]["DICT_RELEASE"] = tag
        RUNTIME.write_text(json.dumps(cfg, indent=2) + "\n")
        wrangler("d1", "execute", "DICT", "--remote", "--file", directory / "etymology.sql", "-y")
        result = json.loads(wrangler("d1", "execute", "DICT", "--remote", "--json",
                                    "--command", "SELECT count(*) AS n FROM word", capture=True))
        if result[0]["results"][0]["n"] != manifest["row_count"]:
            raise ValueError("Remote dictionary count mismatch")
        wrangler("d1", "execute", "APP", "--remote", "--file", directory / "word-stats.sql", "-y")
        # State is durable across ordinary app deploys; workflow concurrency holds
        # the same lock for this switch, migrations, deploys, and backups.
        save_state(candidate)
        try:
            deploy()
        except Exception:
            save_state(previous)
            deploy()
            raise
        print(f"Dictionary switched to {tag}; previous DICT retained: {previous['database_id']}")


def backup():
    cfg, state = render()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        sql = directory / "app.sql"
        # Wrangler prints a signed download URL; keep it out of CI logs.
        wrangler("d1", "export", "APP", "--remote", "--output", sql, capture=True)
        db = sqlite3.connect(":memory:")
        db.executescript(sql.read_text())
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Export failed local integrity checks")
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        counts = {t: db.execute('SELECT count(*) FROM "'+t.replace('"','""')+'"').fetchone()[0] for t in tables}
        db.close()
        compressed = directory / "app.sql.gz"
        compressed.write_bytes(gzip.compress(sql.read_bytes(), mtime=0))
        key = f"app/{stamp}"
        record = {"created_at": stamp, "app": cfg["d1_databases"][1], "dictionary": state,
                  "commit": run("git", "rev-parse", "HEAD", capture=True).strip(),
                  "migrations_sha256": {p.name: digest(p) for p in (ROOT / "apps/api/drizzle").glob("*.sql")},
                  "sha256": digest(compressed), "sql_sha256": digest(sql), "table_counts": counts}
        manifest = directory / "manifest.json"
        manifest.write_text(json.dumps(record, indent=2) + "\n")
        wrangler("r2", "object", "put", f"{BUCKET}/{key}.sql.gz", "--remote", "--file", compressed)
        wrangler("r2", "object", "put", f"{BUCKET}/{key}.json", "--remote", "--file", manifest)
        print(f"Verified private backup: {key}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "verify", "render", "deploy", "release", "backup"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    if args.operation in ("prepare", "verify", "release") and not args.value:
        parser.error("This operation requires a directory or release tag")
    {"prepare": lambda: prepare(args.value), "verify": lambda: print(verify(args.value)["row_count"]),
     "render": render, "deploy": deploy, "release": lambda: release(args.value), "backup": backup}[args.operation]()
