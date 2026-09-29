"""Exercise the pool-order migration against populated legacy APP tables."""
from contextlib import closing
import sqlite3
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / 'apps/api/drizzle'
COLUMNS = 'card_id,likes,dislikes,prior,score,updated_at'


class PoolMigrationTest(unittest.TestCase):
    def test_preserves_ratings_and_randomizes_existing_and_future_cards(self):
        with closing(sqlite3.connect(':memory:')) as db:
            db.executescript((MIGRATIONS / '0000_initial.sql').read_text())
            rows = [(f'word-{i}', i % 7, i % 13, 0.8, 0.55, i) for i in range(2000)]
            db.executemany(f'INSERT INTO word_stats ({COLUMNS}) VALUES (?,?,?,?,?,?)', rows)
            before = db.execute(f'SELECT {COLUMNS} FROM word_stats ORDER BY card_id').fetchall()
            db.executescript((MIGRATIONS / '0001_random_pool_ties.sql').read_text())
            self.assertEqual(db.execute(f'SELECT {COLUMNS} FROM word_stats ORDER BY card_id').fetchall(), before)
            self.assertEqual(db.execute('SELECT count(DISTINCT pool_order) FROM word_stats').fetchone()[0], len(rows))
            self.assertIn('WITHOUT ROWID', db.execute("SELECT sql FROM sqlite_master WHERE name='word_stats'").fetchone()[0])
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            db.execute(f"INSERT INTO word_stats ({COLUMNS}) VALUES ('new',0,0,0.8,0.5,0)")
            key = db.execute("SELECT pool_order FROM word_stats WHERE card_id='new'").fetchone()[0]
            self.assertRegex(key, r'^[0-9A-F]{16}$')
            db.execute(f"INSERT INTO word_stats ({COLUMNS}) VALUES ('new',0,0,0.8,0.5,0) ON CONFLICT(card_id) DO NOTHING")
            self.assertEqual(db.execute("SELECT pool_order FROM word_stats WHERE card_id='new'").fetchone()[0], key)


if __name__ == '__main__':
    unittest.main()
