import json
import unittest
from pathlib import Path

from etymology_selection import exclusion_reason

evaluate = exclusion_reason

HERE = Path(__file__).resolve().parent


def card(text, pos='noun'):
    return {'etymology': text, 'def_pos': pos, 'pos': [pos]}


class FinalSelectionTests(unittest.TestCase):
    def test_all_supplied_examples(self):
        for example in json.loads((HERE / 'etymology-round-three-examples.json').read_text()):
            for row in example['cards']:
                with self.subTest(word=row['word']):
                    self.assertEqual(evaluate(row), 'expanded_bare_provenance')

    def test_prior_accepted_examples(self):
        for text in json.loads((HERE / 'etymology-examples.json').read_text()):
            with self.subTest(text=text):
                self.assertIsNotNone(exclusion_reason(card(text)))
        for example in json.loads((HERE / 'etymology-round-two-examples.json').read_text()):
            for row in example['cards']:
                with self.subTest(word=row['word']):
                    self.assertIsNotNone(exclusion_reason(row))

    def test_new_syntax_does_not_consume_explanations(self):
        cases = [
            'Ultimately of German origin, named after a village where the family lived.',
            'From Mexican Spanish pulque, possibly from Nahuatl. The meaning changed over time.',
            'Romanization of Korean 이두 (idu), literally “clerk reading”.',
            'French asine, from Latin asina (“she-ass”).',
            'From Tibetan སྨན་གླིང (sman gling, “medicine land”).',
            'From fore- + shine. Possibly cognate with German Vorschein, referring to an early light.',
            'Ultimately from Arabic قُرْبَان (qurbān), probably through Malay korban, named after a ritual.',
            'From over- + Anglo-Norman plus, Middle French plus (“more”).',
            'From the French surname, variant of Primeau, used as a joke about its bearer.',
            'Via Latin Tyrrhēnia from Ancient Greek Τυρρηνῐ́ᾱ (Turrhēnĭ́ā), after the local inhabitants.',
            'From Middle English -ar, -are, variant of Middle English -ere. More at -er. The ending changed its function.',
            'From pagan + -ity; cf. Latin paganitas. The word was coined in a religious debate.',
            'Americanized spelling of German Scholle, adopted to hide the family’s background.',
            'Ultimately onomatopoeic. Compare expressions of laughter.',
            'From Latin with an unrecognized but potentially interesting explanation.',
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertIsNone(exclusion_reason(card(text)))

    def test_proper_noun_guard_and_narrative_preserved(self):
        text = 'Ultimately from Tibetan སྨན་གླིང (sman gling, “medicine land”).'
        self.assertIsNone(evaluate(card(text)))
        self.assertIsNone(evaluate({'etymology': text, 'def_pos': 'proper noun', 'pos': ['proper noun', 'noun']}))
        self.assertEqual(evaluate(card(text, 'proper noun')), 'proper_noun_glossed_provenance')
        self.assertIsNone(exclusion_reason(card(text + ' Named after a monastery.', 'proper noun')))
        self.assertIsNone(exclusion_reason(card('Ultimately from Latin, literally “shining star”.', 'proper noun')))

    def test_positive_source_senses(self):
        rows = json.loads((HERE / 'etymology-positive-examples.json').read_text())
        self.assertEqual(len(rows), 5)
        for row in rows:
            with self.subTest(word=row['word'], etym_no=row['etym_no']):
                self.assertIsNone(exclusion_reason(dict(row)))


if __name__ == '__main__':
    unittest.main()
