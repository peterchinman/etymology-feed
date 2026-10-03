"""Exercise the rater-trust migration against populated APP tables."""
from contextlib import closing
import sqlite3
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / 'apps/api/drizzle'
SWIPE = 'id,user_id,card_id,verdict,bucket,shown_at,swiped_at,received_at'


class RaterMigrationTest(unittest.TestCase):
    def test_existing_ratings_stay_counted_and_their_raters_trusted(self):
        with closing(sqlite3.connect(':memory:')) as db:
            db.execute('PRAGMA foreign_keys = ON')
            for name in ('0000_initial.sql', '0001_random_pool_ties.sql'):
                db.executescript((MIGRATIONS / name).read_text())
            for user in ('reader', 'fan', 'idle'):
                db.execute(
                    'INSERT INTO user (id,name,email,updated_at) VALUES (?,?,?,0)',
                    (user, user, f'{user}@test.local'),
                )
            db.executemany(
                f'INSERT INTO swipe ({SWIPE}) VALUES (?,?,?,?,NULL,0,0,0)',
                [
                    ('s1', 'reader', 'alpha', 1),
                    ('s2', 'reader', 'beta', -1),
                    ('s3', 'fan', 'alpha', 1),
                ],
            )
            db.executemany(
                'INSERT INTO served (user_id,card_ids,count,updated_at) VALUES (?,?,?,0)',
                [('reader', '["alpha","beta"]', 2), ('idle', '["gamma"]', 1)],
            )
            db.executescript((MIGRATIONS / '0002_rater_trust.sql').read_text())

            self.assertEqual(
                db.execute('SELECT DISTINCT dealt, tally FROM swipe').fetchall(), [(1, 1)]
            )
            self.assertEqual(
                db.execute('SELECT user_id, status, rated, liked FROM rater ORDER BY user_id').fetchall(),
                [('fan', 'trusted', 1, 1), ('reader', 'trusted', 2, 1)],
            )
            self.assertEqual(
                db.execute('SELECT count(*) FROM served WHERE dealt_ids <> card_ids').fetchone()[0], 0
            )
            self.assertIn('WITHOUT ROWID', db.execute("SELECT sql FROM sqlite_master WHERE name='rater'").fetchone()[0])
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

            # New rows start uncounted, and the status check holds.
            db.execute(f"INSERT INTO swipe ({SWIPE}) VALUES ('s4','idle','gamma',1,NULL,0,0,0)")
            self.assertEqual(db.execute("SELECT dealt, tally FROM swipe WHERE id='s4'").fetchone(), (0, 0))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO rater (user_id,status,credit_at,updated_at) VALUES ('idle','maybe',0,0)"
                )
            # Only flag requests enter the partial index the cron reads.
            plan = db.execute(
                "EXPLAIN QUERY PLAN SELECT user_id FROM rater WHERE status = 'flagging' LIMIT 50"
            ).fetchall()
            self.assertTrue(any('idx_rater_flagging' in row[-1] for row in plan))


if __name__ == '__main__':
    unittest.main()
