-- Applied before app deployment, including when switching dictionary releases.
CREATE INDEX IF NOT EXISTS idx_word_search ON word(word COLLATE NOCASE, word);
