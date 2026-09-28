"""Exercise reviewed rules through the release builder and SQL export."""

import json
import sqlite3
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from source_fixture import SCHEMA, insert_entries, pin_source
import derive_etymology as derive


class SelectionTest(unittest.TestCase):
    def test_filter_and_cleanup_preserve_sense_identity_and_recompute_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / 'dictionary.db'
            originals = [
                'From German Dithmarschen' + ', from German Dithmarschen' * 12 + '.',
                'PIE word\n *h₁én\nFrom Latin ūnus (“one”).',
                'From\nEtymology tree\nLatin exemplum\nEnglish example',
                'From Arabic مِرْفَق (mirfaq, “elbow”).',
                'From Arabic مِرْفَق (mirfaq, “elbow”).',
                'Partial calque of German Blitzschach.',
                'From Arabic مِرْفَق (mirfaq, “elbow”).',
            ]
            with sqlite3.connect(source_path) as source:
                source.executescript(SCHEMA)
                source.execute("INSERT INTO pos VALUES ('noun','noun',1)")
                source.execute("INSERT INTO pos VALUES ('name','proper noun',2)")
                source.execute(
                    "INSERT INTO word (id,word,length,pos_mask,tier,zipf,capitalized,multiword,"
                    "hyphenated,apostrophe,digits,nonascii,pointer_only,archaic,technical,books,ipa) "
                    "VALUES (1,'example',7,1,'common',3,0,0,0,0,0,0,0,0,0,0,NULL)"
                )
                entries = [
                    {'pos': 'name' if n in (4, 7) else 'noun', 'etym_no': n, 'etymology': text,
                     'senses': [{'gloss': f'Definition {n}.'}]}
                    for n, text in enumerate(originals, 1)
                ]
                # The same origin has both name and common-noun senses: keep it.
                entries.append({'pos': 'noun', 'etym_no': 7, 'etymology': originals[6],
                                'senses': [{'gloss': 'A common-noun sense.', 'demoted': True}]})
                insert_entries(source, entries)
            derive.build(Namespace(source=source_path, source_manifest=pin_source(source_path), output_dir=root / 'output',
                                   pointer_max_length=70, story_min_length=80))
            with sqlite3.connect(root / 'output' / 'etymology.db') as db:
                db.row_factory = sqlite3.Row
                rows = db.execute('SELECT * FROM word ORDER BY etym_no').fetchall()
                self.assertEqual([r['etym_no'] for r in rows], [2, 5, 7])
                for row in rows[1:]:
                    n = row['etym_no']
                    self.assertEqual(row['id'], derive.card_id('example', n, originals[n - 1], False))
                    self.assertEqual(row['definition'], f'Definition {n}.')
                    self.assertEqual(row['etymology'], originals[n - 1])
                self.assertEqual(set(json.loads(rows[2]['pos'])), {'proper noun', 'noun'})
                self.assertEqual(rows[2]['def_pos'], 'proper noun')
                card = rows[0]
                clean = 'From Latin ūnus (“one”).'
                self.assertEqual(card['id'], derive.card_id('example', 2, originals[1], False))
                self.assertEqual(card['definition'], 'Definition 2.')
                self.assertEqual(card['etymology'], clean)
                self.assertEqual(card['etym_len'], len(clean))
                self.assertEqual(card['etym_band'], derive.band(len(clean)))
                self.assertEqual(card['prior'], derive.prior(clean, 'common', derive.signals(clean)[0]))
                self.assertEqual(sorted(r['shuffle'] for r in rows), [1, 2, 3])
                meta = dict(db.execute('SELECT key,value FROM meta'))
                self.assertEqual(meta['classifier_version'], '4')
                self.assertEqual(json.loads(meta['selection_counts']), {
                    'display_cleaned': 2, 'provenance_only': 1, 'ineligible_after_cleanup': 1,
                    'expanded_bare_provenance': 1, 'proper_noun_glossed_provenance': 1,
                })
                expected = [tuple(row) for row in rows]
            with sqlite3.connect(':memory:') as imported:
                imported.executescript((root / 'output' / 'etymology.sql').read_text())
                self.assertEqual(imported.execute('SELECT * FROM word ORDER BY etym_no').fetchall(), expected)


if __name__ == '__main__':
    unittest.main()
