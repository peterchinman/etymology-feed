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
from uuid import UUID, uuid4
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
    if dict(local.execute("SELECT key,value FROM meta")) != meta:
        raise ValueError("SQL and SQLite metadata differ")
    layout = db.execute("SELECT count(DISTINCT id),count(DISTINCT shuffle),min(shuffle),max(shuffle),sum(typeof(shuffle) != 'integer') FROM word").fetchone()
    if count < 1 or layout != (count, count, 1, count, 0):
        raise ValueError("Dictionary shuffle must be a complete integer permutation")
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
    if str(UUID(state["database_id"])) != state["database_id"]:
        raise ValueError("Invalid production dictionary ID")
    cfg = json.loads(CONFIG.read_text())
    app_id = next(item["database_id"] for item in cfg["d1_databases"] if item["binding"] == "APP")
    if state["database_id"] == app_id or not re.fullmatch(r"feed-[a-zA-Z0-9.-]+", state["release"]):
        raise ValueError("Production dictionary state targets APP or has an invalid release")
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


def check_membership(previous_db, next_db):
    def ids(path):
        with sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True) as db:
            return {row[0] for row in db.execute("SELECT id FROM word")}
    removed = ids(previous_db) - ids(next_db)
    if removed:
        raise ValueError(f"Release removes {len(removed)} cards. Review APP pool membership before switching; no production data changed.")


def deploy():
    cfg, state = render()
    commit = run("git", "rev-parse", "HEAD", capture=True).strip()
    cfg["vars"]["APP_COMMIT"] = commit
    RUNTIME.write_text(json.dumps(cfg, indent=2) + "\n")
    wrangler("d1", "migrations", "apply", "APP", "--remote")
    wrangler("d1", "execute", "DICT", "--remote", "--file",
             ROOT / "apps/api/dictionary/search-index.sql", "-y")
    wrangler("deploy")
    run("node", "scripts/smoke-production.mjs", "https://etymologyfeed.com", commit, state["release"])


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
        # APP keeps historical ratings. Until retired-card membership is modeled
        # explicitly, never let an automatic release leave missing IDs in pools.
        old_directory = directory / "previous"
        run("gh", "release", "download", previous["release"], "--repo", "peterchinman/etymology-feed",
            "--dir", old_directory, "--pattern", "etymology.db", "--pattern", "manifest.json")
        old_manifest = json.loads((old_directory / "manifest.json").read_text())
        if digest(old_directory / "etymology.db") != old_manifest["sha256"]["etymology.db"]:
            raise ValueError("Previous dictionary checksum mismatch")
        check_membership(old_directory / "etymology.db", directory / "etymology.db")
        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        name = f"etymology-feed-dict-{suffix}-{uuid4().hex[:8]}"
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
        try:
            # Include the pointer write: a failed response can still mean the
            # object changed remotely. Restore the previous desired state too.
            save_state(candidate)
            deploy()
        except Exception:
            save_state(previous)
            deploy()
            raise
        print(f"Dictionary switched to {tag}; previous DICT retained: {previous['database_id']}")


def deployed_versions():
    """Record deployed code/bindings, not the checkout running the backup job."""
    deployments = json.loads(wrangler("deployments", "list", "--json", capture=True))
    if not deployments:
        raise ValueError("No Worker deployment found for backup provenance")
    active = max(deployments, key=lambda item: item["created_on"])
    versions = []
    for selection in active["versions"]:
        version = json.loads(wrangler("versions", "view", selection["version_id"], "--json", capture=True))
        bindings = version["resources"]["bindings"]
        # Whitelist nonsecret values; never include all bindings or API metadata.
        text_vars = {b["name"]: b["text"] for b in bindings if b["type"] == "plain_text" and b["name"] in ("APP_COMMIT", "DICT_RELEASE")}
        databases = {b["name"]: b["id"] for b in bindings if b["type"] == "d1" and b["name"] in ("APP", "DICT")}
        versions.append({**selection, "app_commit": text_vars.get("APP_COMMIT"),
                         "dictionary_release": text_vars.get("DICT_RELEASE"), "databases": databases})
    return {"deployment_id": active["id"], "created_on": active["created_on"], "versions": versions}


def backup():
    cfg, state = render()
    deployed = deployed_versions()
    active = max(deployed["versions"], key=lambda version: version["percentage"])
    dictionary = state
    dictionary_source = "desired-state-unconfirmed"
    if active["databases"].get("DICT") and active["dictionary_release"]:
        dictionary = {"database_id": active["databases"]["DICT"], "release": active["dictionary_release"]}
        dictionary_source = "deployed-worker"
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
        record = {"created_at": stamp, "app": cfg["d1_databases"][1], "dictionary": dictionary,
                  "dictionary_source": dictionary_source, "desired_dictionary": state,
                  "deployment": deployed,
                  "backup_script_commit": run("git", "rev-parse", "HEAD", capture=True).strip(),
                  "backup_script_migrations_sha256": {p.name: digest(p) for p in (ROOT / "apps/api/drizzle").glob("*.sql")},
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
