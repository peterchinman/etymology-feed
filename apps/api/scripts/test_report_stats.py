import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path(__file__).with_name("report_stats.py")


class ReportStatsTest(unittest.TestCase):
    def test_local_exports_report_recent_current_ratings(self):
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dictionary = root / "etymology.db"
            with sqlite3.connect(dictionary) as connection:
                connection.executescript(
                    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"
                    "INSERT INTO meta VALUES ('source_release','fixture-release');"
                    "CREATE TABLE word (word TEXT PRIMARY KEY, etym_band TEXT, "
                    "shape TEXT, tier TEXT, has_signal INTEGER);"
                    "INSERT INTO word VALUES ('alpha','80_120','plain','common',1);"
                    "INSERT INTO word VALUES ('beta','lt40','multiword,capitalized','rare',0);"
                )

            def stamp(days_ago):
                return int((now - timedelta(days=days_ago)).timestamp() * 1000)

            swipes = root / "swipes.sql"
            swipes.write_text(
                "INSERT INTO swipe VALUES "
                f"('a','u','alpha',1,'rec',0,0,{stamp(0)}),"
                f"('b','u','beta',-1,'unknown',0,0,{stamp(1)}),"
                f"('c','v','alpha',1,'wild',0,0,{stamp(10)}),"
                f"('d','v','beta',1,'wild',0,0,{stamp(40)}),"
                f"('e','v','missing',1,'rec',0,0,{stamp(0)});",
                encoding="utf-8",
            )
            stats = root / "word-stats.sql"
            stats.write_text(
                "INSERT INTO word_stats VALUES "
                "('alpha',5,0,0.5,0.75,0),('beta',0,2,0.5,0.36,0);",
                encoding="utf-8",
            )
            output = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--swipes-sql",
                    str(swipes),
                    "--word-stats-sql",
                    str(stats),
                    "--dict-db",
                    str(dictionary),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            report = json.loads(output.stdout)

        self.assertEqual(report["dictionaryRelease"], "fixture-release")
        self.assertEqual(report["periods"]["30"]["total"], {"likes": 3, "total": 4})
        self.assertEqual(report["periods"]["7"]["total"], {"likes": 2, "total": 3})
        self.assertEqual(report["globalLikeRate"], 0.75)
        self.assertEqual(report["periods"]["30"]["etymBand"]["lt40"]["likeRate"], 0)
        self.assertEqual(report["periods"]["30"]["shape"]["capitalized"]["total"], 1)
        self.assertEqual(report["ratedWords"], 1)
        self.assertEqual(report["recommendedEligibleWords"], 1)
        self.assertEqual(report["unknownWords"], 1)
        self.assertEqual(report["missingDictionaryRows"], 1)
        self.assertEqual(report["swipesPerDay"][0]["count"], 2)


if __name__ == "__main__":
    unittest.main()
