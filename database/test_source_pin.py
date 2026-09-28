"""The consumer checks its exact source pin before writing a feed artifact."""
import json
import sqlite3
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

import derive_etymology as derive
from source_fixture import SCHEMA, insert_entries, pin_source


class SourcePinTests(unittest.TestCase):
    def test_source_provenance_is_exported_and_input_is_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'dictionary.db'
            with sqlite3.connect(path) as db:
                db.executescript(SCHEMA)
                db.execute("INSERT INTO pos VALUES ('noun','noun',1)")
                db.execute("INSERT INTO word (id,word,tier) VALUES (1,'rival','common')")
                insert_entries(db, [{'pos': 'noun', 'etym_no': 1,
                    'etymology': 'From Latin rivālis (“one who shares a stream”).',
                    'senses': [{'gloss': 'A competitor.'}]}])
            pin = pin_source(path)
            before = path.read_bytes()
            path.chmod(0o444)
            args = Namespace(source=path, source_manifest=pin, output_dir=root / 'output',
                             pointer_max_length=70, story_min_length=80)
            derive.build(args)
            self.assertEqual(path.read_bytes(), before)
            with sqlite3.connect(args.output_dir / 'etymology.db') as db:
                metadata = dict(db.execute('SELECT key,value FROM meta'))
                self.assertEqual(metadata['source_repository'], 'test/full-dictionary')
                self.assertEqual(metadata['source_release'], 'fixture-v1')
                self.assertEqual(metadata['source_sha256'], json.loads(pin.read_text())['sha256'])
                self.assertEqual(metadata['source_published'], 'false')
            with sqlite3.connect(':memory:') as exported:
                exported.executescript((args.output_dir / 'etymology.sql').read_text())
                self.assertEqual(dict(exported.execute('SELECT key,value FROM meta')), metadata)

    def test_wrong_source_fails_before_touching_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'dictionary.db'
            source.write_bytes(b'wrong source')
            pin = pin_source(source)
            source.write_bytes(b'changed source')
            out = root / 'output'
            out.mkdir()
            result = out / 'etymology.db'
            result.write_bytes(b'existing artifact')
            args = Namespace(source=source, source_manifest=pin, output_dir=out,
                             pointer_max_length=70, story_min_length=80)
            with self.assertRaisesRegex(ValueError, 'source checksum mismatch'):
                derive.build(args)
            self.assertEqual(result.read_bytes(), b'existing artifact')
            self.assertFalse((out / 'etymology.db.tmp').exists())

    def test_pre_entry_link_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'old.db'
            with sqlite3.connect(source) as db:
                db.executescript('CREATE TABLE etymology (text TEXT); CREATE TABLE meaning (definition TEXT); CREATE TABLE pronunciation (ipa TEXT);')
            args = Namespace(source=source, source_manifest=pin_source(source), output_dir=root / 'output',
                             pointer_max_length=70, story_min_length=80)
            with self.assertRaisesRegex(ValueError, 'predates sense-to-etymology links'):
                derive.build(args)
            self.assertFalse(args.output_dir.exists())


if __name__ == '__main__':
    unittest.main()
