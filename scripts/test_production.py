from pathlib import Path
import sqlite3
import copy
import json
import shutil
from unittest.mock import patch
import production
import tempfile
import unittest
from production import check_membership, prepare, verify


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        db = sqlite3.connect(self.path / 'etymology.db')
        db.executescript("""
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
            INSERT INTO meta VALUES('source_published','true'),('row_count','2');
            CREATE TABLE word(id TEXT PRIMARY KEY,prior REAL,shuffle INTEGER);
            INSERT INTO word VALUES('bluff',0.6,1),('bluff::second',0.7,2);
        """)
        (self.path / 'etymology.sql').write_text('\n'.join(db.iterdump()))
        (self.path / 'etymology-report.txt').write_text('fixture')
        db.close()

    def test_seed_preserves_existing_ratings_and_is_repeatable(self):
        prepare(self.path)
        db = sqlite3.connect(':memory:')
        db.executescript('CREATE TABLE word_stats(card_id TEXT PRIMARY KEY,likes INTEGER,dislikes INTEGER,prior REAL,score REAL,updated_at INTEGER);')
        db.execute("INSERT INTO word_stats VALUES('bluff',8,2,0.4,0.9,123)")
        sql = (self.path / 'word-stats.sql').read_text()
        db.executescript(sql)
        db.executescript(sql)
        self.assertEqual(db.execute("SELECT likes,dislikes,score,updated_at FROM word_stats WHERE card_id='bluff'").fetchone(), (8,2,0.9,123))
        self.assertEqual(db.execute('SELECT count(*) FROM word_stats').fetchone()[0], 2)
        self.assertEqual(verify(self.path)['row_count'], 2)

    def test_rejects_tampered_sql_before_remote_import(self):
        prepare(self.path)
        with (self.path / 'etymology.sql').open('a') as f:
            f.write('\nDELETE FROM word;')
        with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
            verify(self.path)

    def test_rejects_gapped_shuffle_even_with_valid_checksums(self):
        with sqlite3.connect(self.path / 'etymology.db') as db:
            db.execute("UPDATE word SET shuffle=99 WHERE shuffle=2")
            (self.path / 'etymology.sql').write_text('\n'.join(db.iterdump()))
        prepare(self.path)
        with self.assertRaisesRegex(ValueError, 'complete integer permutation'):
            verify(self.path)

    def test_rejects_sqlite_metadata_different_from_sql(self):
        with sqlite3.connect(self.path / 'etymology.db') as db:
            db.execute("INSERT INTO meta VALUES('extra','mismatch')")
        prepare(self.path)
        # Match the SQL manifest to prove the separate SQLite check catches drift.
        manifest = json.loads((self.path / 'manifest.json').read_text())
        del manifest['source']['extra']
        (self.path / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'metadata differ'):
            verify(self.path)

    def test_unpublished_source_cannot_be_prepared(self):
        db = sqlite3.connect(self.path / 'etymology.db')
        db.execute("UPDATE meta SET value='false' WHERE key='source_published'")
        db.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, 'Publish'):
            prepare(self.path)

    def test_removing_cards_requires_pool_membership_review(self):
        previous = self.path / 'etymology.db'
        candidate = self.path / 'candidate.db'
        candidate.write_bytes(previous.read_bytes())
        check_membership(previous, candidate)
        with sqlite3.connect(candidate) as db:
            db.execute("DELETE FROM word WHERE id='bluff::second'")
        with self.assertRaisesRegex(ValueError, 'removes 1 cards'):
            check_membership(previous, candidate)


class BackupProvenanceTests(unittest.TestCase):
    def test_records_active_versions_and_only_nonsecret_bindings(self):
        deployments = [{"id": "old", "created_on": "2026-01-01", "versions": []},
                       {"id": "active", "created_on": "2026-02-01", "versions": [{"version_id": "v2", "percentage": 100}]}]
        version = {"resources": {"bindings": [
            {"type": "plain_text", "name": "APP_COMMIT", "text": "deployed-sha"},
            {"type": "plain_text", "name": "DICT_RELEASE", "text": "feed-live"},
            {"type": "d1", "name": "DICT", "id": "dict-id"},
            {"type": "secret_text", "name": "GOOGLE_CLIENT_SECRET", "text": "must-not-be-recorded"},
        ]}}
        with patch.object(production, 'wrangler', side_effect=[json.dumps(deployments), json.dumps(version)]):
            snapshot = production.deployed_versions()
        self.assertEqual(snapshot['deployment_id'], 'active')
        self.assertEqual(snapshot['versions'][0]['app_commit'], 'deployed-sha')
        self.assertEqual(snapshot['versions'][0]['databases'], {'DICT': 'dict-id'})
        self.assertNotIn('must-not-be-recorded', json.dumps(snapshot))


class ReleaseRecoveryTests(unittest.TestCase):
    """Exercise the real release coordinator, substituting only external I/O."""

    def test_failed_release_and_retry_preserve_statistics(self):
        for failure in ("seed", "pointer", "deploy", "smoke"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                assets = {}
                for tag, extra in (("feed-old", False), ("feed-new", True)):
                    directory = root / tag
                    directory.mkdir()
                    with sqlite3.connect(directory / "etymology.db") as db:
                        db.executescript("""
                            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
                            INSERT INTO meta VALUES('source_published','true');
                            CREATE TABLE word(id TEXT PRIMARY KEY,prior REAL,shuffle INTEGER);
                            INSERT INTO word VALUES('bluff',0.6,1),('bluff::second',0.7,2);
                        """)
                        if extra:
                            db.execute("INSERT INTO word VALUES('new-card',0.8,3)")
                        db.execute("INSERT INTO meta VALUES('row_count',?)", (str(3 if extra else 2),))
                        (directory / "etymology.sql").write_text("\n".join(db.iterdump()))
                    (directory / "etymology-report.txt").write_text("fixture")
                    prepare(directory)
                    assets[tag] = directory
                app = sqlite3.connect(":memory:")
                self.addCleanup(app.close)
                app.executescript("CREATE TABLE word_stats(card_id TEXT PRIMARY KEY,likes INTEGER,dislikes INTEGER,prior REAL,score REAL,updated_at INTEGER);")
                app.executescript((assets["feed-old"] / "word-stats.sql").read_text())
                app.execute("UPDATE word_stats SET likes=8,dislikes=2,score=0.9,updated_at=123 WHERE card_id='bluff'")
                previous = {"database_id": "00000000-0000-0000-0000-000000000000",
                            "database_name": "old-dict", "release": "feed-old"}
                state = copy.deepcopy(previous)
                deployed = copy.deepcopy(previous)
                names = []
                databases = {}
                failed = False
                runtime = root / "runtime.json"

                def render():
                    cfg = {"d1_databases": [{"binding": "DICT", **state}, {"binding": "APP"}],
                           "vars": {"DICT_RELEASE": state["release"]}}
                    runtime.write_text(json.dumps(cfg))
                    return cfg, copy.deepcopy(state)

                def save_state(candidate):
                    nonlocal state, failed
                    state = copy.deepcopy(candidate)
                    if failure == "pointer" and not failed and state["release"] == "feed-new":
                        failed = True
                        raise RuntimeError("injected pointer failure after write")

                def run(*args, **kwargs):
                    nonlocal failed
                    if args == ("git", "rev-parse", "HEAD"):
                        return "f" * 40
                    elif args[:3] == ("gh", "release", "download"):
                        directory = Path(args[args.index("--dir") + 1])
                        shutil.copytree(assets[args[3]], directory, dirs_exist_ok=True)
                    elif args[:2] == ("node", "scripts/smoke-production.mjs"):
                        if failure == "smoke" and not failed and deployed["release"] == "feed-new":
                            # A rating arrives while the new Worker is serving.
                            app.execute("UPDATE word_stats SET likes=1,score=0.667,updated_at=456 WHERE card_id='new-card'")
                            failed = True
                            raise RuntimeError("injected smoke failure")
                    else:
                        self.fail(f"Unexpected external command: {args}")

                def wrangler(*args, **kwargs):
                    nonlocal deployed, failed
                    cfg = json.loads(runtime.read_text())
                    if args[:2] == ("d1", "create"):
                        names.append(args[2])
                        database_id = f"00000000-0000-0000-0000-{len(names):012d}"
                        databases[database_id] = sqlite3.connect(":memory:")
                        self.addCleanup(databases[database_id].close)
                        return json.dumps({"database_id": database_id})
                    if args[:2] == ("d1", "execute"):
                        db = app if args[2] == "APP" else databases[cfg["d1_databases"][0]["database_id"]]
                        if "--file" in args:
                            db.executescript(Path(args[args.index("--file") + 1]).read_text())
                            if failure == "seed" and not failed and args[2] == "APP":
                                failed = True
                                raise RuntimeError("injected seed failure after write")
                        else:
                            n = db.execute(args[args.index("--command") + 1]).fetchone()[0]
                            return json.dumps([{"results": [{"n": n}]}])
                    elif args[:3] == ("d1", "migrations", "apply"):
                        pass
                    elif args == ("deploy",):
                        deployed = copy.deepcopy(state)
                        if failure == "deploy" and not failed and state["release"] == "feed-new":
                            failed = True
                            raise RuntimeError("injected deploy failure after activation")
                    else:
                        self.fail(f"Unexpected Wrangler command: {args}")

                with patch.multiple(production, render=render, save_state=save_state,
                                    run=run, wrangler=wrangler, RUNTIME=runtime):
                    with self.assertRaisesRegex(RuntimeError, "injected"):
                        production.release("feed-new")
                    self.assertEqual(state, previous)
                    self.assertEqual(deployed, previous)
                    before_retry = app.execute("SELECT * FROM word_stats ORDER BY card_id").fetchall()
                    self.assertEqual(len(before_retry), 3)
                    production.release("feed-new")
                    self.assertEqual(state["release"], "feed-new")
                    self.assertEqual(deployed, state)
                    self.assertEqual(app.execute("SELECT * FROM word_stats ORDER BY card_id").fetchall(), before_retry)
                    self.assertEqual(len(set(names)), 2, "Retry must use a fresh immutable DICT")
                    self.assertEqual(app.execute("SELECT likes,dislikes,score,updated_at FROM word_stats WHERE card_id='bluff'").fetchone(), (8,2,0.9,123))
                    # An interrupted job retried after the pointer was saved is idempotent.
                    production.release("feed-new")
                    self.assertEqual(len(names), 2)
                    self.assertEqual(app.execute("SELECT * FROM word_stats ORDER BY card_id").fetchall(), before_retry)


if __name__ == '__main__':
    unittest.main()
