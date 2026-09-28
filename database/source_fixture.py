"""Small SQLite fixtures for the full-dictionary input contract (no RWG imports)."""
import hashlib
import json

# Only the tables/columns needed by the consumer and its fixtures. This is test
# data, not a second implementation of RWG's extraction or source build.
SCHEMA = """
CREATE TABLE pos (code TEXT PRIMARY KEY, name TEXT NOT NULL, bit INTEGER NOT NULL);
CREATE TABLE word (
    id INTEGER PRIMARY KEY, word TEXT NOT NULL, length INTEGER, pos_mask INTEGER,
    tier TEXT NOT NULL, zipf REAL, capitalized INTEGER, multiword INTEGER,
    hyphenated INTEGER, apostrophe INTEGER, digits INTEGER, nonascii INTEGER,
    pointer_only INTEGER, archaic INTEGER, technical INTEGER, books INTEGER, ipa TEXT
);
CREATE TABLE meaning (
    id INTEGER PRIMARY KEY, word_id INTEGER, entry_no INTEGER, ord INTEGER,
    pos TEXT, kind TEXT, definition TEXT, demoted INTEGER
);
CREATE TABLE pronunciation (
    id INTEGER PRIMARY KEY, word_id INTEGER, entry_no INTEGER, ipa TEXT, tags TEXT
);
CREATE TABLE etymology (
    id INTEGER PRIMARY KEY, word_id INTEGER, entry_no INTEGER, etym_no INTEGER, text TEXT
);
"""


def insert_entries(db, entries):
    """Insert explicit already-extracted senses, preserving their source entries."""
    order = 0
    for entry_no, entry in enumerate(entries, 1):
        db.execute('INSERT INTO etymology (word_id,entry_no,etym_no,text) VALUES (1,?,?,?)',
                   (entry_no, entry['etym_no'], entry['etymology']))
        for sense in entry['senses']:
            order += 1
            db.execute(
                'INSERT INTO meaning (word_id,entry_no,ord,pos,kind,definition,demoted) '
                'VALUES (1,?,?,?,?,?,?)',
                (entry_no, order, entry['pos'], sense.get('kind', 'definition'),
                 sense['gloss'], int(sense.get('demoted', False))),
            )
        for sound in entry.get('sounds', []):
            db.execute('INSERT INTO pronunciation (word_id,entry_no,ipa,tags) VALUES (1,?,?,?)',
                       (entry_no, sound['ipa'], json.dumps(sound.get('tags', []))))


def pin_source(path):
    pin = path.with_suffix('.source.json')
    with path.open('rb') as source:
        checksum = hashlib.file_digest(source, 'sha256').hexdigest()
    pin.write_text(json.dumps({
        'repository': 'test/full-dictionary', 'release': 'fixture-v1',
        'published': False, 'sha256': checksum,
    }))
    return pin
