"""The derived cards keep each Wiktionary origin with its own sense."""

import sqlite3
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from source_fixture import SCHEMA, insert_entries, pin_source
import derive_etymology


class MultiEtymologyTest(unittest.TestCase):
    def test_bluff_origins_keep_their_own_definitions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "dictionary.db"
            source = sqlite3.connect(source_path)
            source.executescript(SCHEMA)
            source.execute("INSERT INTO pos VALUES ('noun','noun',1)")
            source.execute("INSERT INTO pos VALUES ('verb','verb',2)")
            source.execute(
                "INSERT INTO word (id,word,length,pos_mask,tier,zipf,capitalized,multiword,"
                "hyphenated,apostrophe,digits,nonascii,pointer_only,archaic,technical,books,ipa) "
                "VALUES (1,'bluff',5,1,'common',3.68,0,0,0,0,0,0,0,0,0,0,'/blʌf/')"
            )
            pretending = "Probably from Dutch bluffen (“to brag”), from Middle Dutch bluffen (“to make something swell; to bluff”); or from the Dutch noun bluf (“bragging”). Related to German verblüffen (“to stump, perplex”)."
            entries = [
                {"pos": "noun", "etym_no": 1,
                 "etymology": pretending,
                 "sounds": [{"ipa": "/blʌf/", "tags": ["US"]}],
                 "senses": [{"gloss": "An act of bluffing; a false expression of strength."}]},
                {"pos": "noun", "etym_no": 2,
                 "etymology": "Related to Middle Low German blaff (“smooth”).",
                 "sounds": [{"ipa": "/blɐf/", "tags": ["UK"]}],
                 "senses": [{"gloss": "A high, steep bank beside a river."}]},
                {"pos": "verb", "etym_no": 1,
                 "etymology": pretending,
                 "senses": [{"gloss": "To deceive with a false show of strength."}]},
            ]
            insert_entries(source, entries)
            source.commit()
            source.close()

            derive_etymology.build(Namespace(
                source=source_path, source_manifest=pin_source(source_path), output_dir=root / "output",
                pointer_max_length=70, story_min_length=80,
            ))
            with sqlite3.connect(root / "output" / "etymology.db") as cards:
                rows = cards.execute(
                    "SELECT id,etym_no,ipa,pos,definition,etymology FROM word ORDER BY etym_no"
                ).fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0][0], "bluff")
            self.assertEqual(rows[0][2], "/blʌf/")
            self.assertEqual(rows[0][3], '["noun", "verb"]')
            self.assertIn("bluffing", rows[0][4])
            self.assertEqual(rows[1][1], 2)
            self.assertEqual(rows[1][2], "/blɐf/")
            self.assertIn("steep bank", rows[1][4])
            self.assertIn("Middle Low German", rows[1][5])


if __name__ == "__main__":
    unittest.main()
