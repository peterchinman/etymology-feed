import json
import unittest
from pathlib import Path

from etymology_selection import exclusion_reason as evaluate

HERE = Path(__file__).resolve().parent


def card(text, pos='noun'):
    return {'etymology': text, 'def_pos': pos, 'pos': [pos]}


class ReviewedSelectionTests(unittest.TestCase):
    def test_user_examples_with_actual_sense_metadata(self):
        for example in json.loads((HERE / 'etymology-round-two-examples.json').read_text()):
            for row in example['cards']:
                with self.subTest(word=row['word']):
                    self.assertIsNotNone(evaluate(row))

    def test_round_one_examples(self):
        for text in json.loads((HERE / 'etymology-examples.json').read_text()):
            with self.subTest(text=text):
                self.assertIsNotNone(evaluate(card(text)))

    def test_glossed_common_and_mixed_senses_survive(self):
        text = 'From Arabic مِرْفَق (mirfaq, “elbow”).'
        self.assertIsNone(evaluate(card(text)))
        self.assertIsNone(evaluate({'etymology': text, 'def_pos': 'proper noun', 'pos': ['noun', 'proper noun']}))
        self.assertIsNone(evaluate({'etymology': text, 'def_pos': 'noun', 'pos': ['proper noun']}))
        self.assertEqual(evaluate(card(text, 'proper noun')), 'proper_noun_glossed_provenance')

    def test_explanations_and_unknown_syntax_survive(self):
        examples = [
            'From Old English haha, ultimately onomatopoeic.',
            'From Latin rivālis (“one who shares a stream”). Named after a local rivalry.',
            'Named after a town where the cloth was first manufactured.',
            'From French, where it was used as a joke about the clergy.',
            'From Latin, literally “one who shares a stream”.',
            'From Latin mysterium. An unusual explanation follows.',
            'French surname (Fugère), variant of Fougère, named after a famous exile.',
            'From Latin Barca, from the local tribe of the Barraci, who settled here.',
            'From Latin causa (“cause”), referring to a dispute over the name.',
            'See Dutch for the story of the name.',
        ]
        for text in examples:
            with self.subTest(text=text):
                self.assertIsNone(evaluate(card(text, 'proper noun')))

    def test_existing_positive_senses(self):
        rows = json.loads((HERE / 'etymology-positive-examples.json').read_text())
        self.assertEqual(len(rows), 5)
        for row in rows:
            with self.subTest(word=row['word'], etym_no=row['etym_no']):
                self.assertIsNone(evaluate(dict(row)))


if __name__ == '__main__':
    unittest.main()
