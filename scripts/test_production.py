from pathlib import Path
import sqlite3
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


if __name__ == '__main__':
    unittest.main()
