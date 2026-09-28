import json
import unittest
from pathlib import Path

from etymology_rules import clean_display, evaluate

HERE=Path(__file__).resolve().parent


class RuleTests(unittest.TestCase):
    def test_all_user_examples(self):
        for text in json.loads((HERE/'etymology-examples.json').read_text()):
            with self.subTest(text=text):
                self.assertIsNotNone(evaluate(text)['reason'])

    def test_explanations_and_glosses_are_not_bare_provenance(self):
        examples=[
            'Named after a town where the cloth was first manufactured.',
            'From French, where it was used as a joke about the clergy.',
            'From Latin rivālis (“one who shares a stream”).',
            'From Latin licitātiō, from licitari, liceri (“to bid, offer a price”).',
            'From French ancien, literally old.',
            'Borrowed from French café. Named after a meeting place for writers.',
            'From German, originally a military nickname.',
            'From Old English haha, ultimately onomatopoeic.',
            'From Latin root. The meaning changed when it became a surname.',
        ]
        for text in examples:
            with self.subTest(text=text):self.assertIsNone(evaluate(text)['reason'])

    def test_tree_boundaries_preserve_prose(self):
        before='Some introductory prose.\nEtymology tree\nProto-Indo-European *foo?\nUnknown Language form\nEnglish example\nFrom a meaningful account.\nA later explanation.'
        clean,removed=clean_display(before,'example')
        self.assertEqual(clean,'Some introductory prose.\nFrom a meaningful account.\nA later explanation.')
        self.assertEqual(removed[-1],'English example')
        self.assertEqual(clean_display(clean,'example'),(clean,[]))
        # An unbounded or malformed block is kept rather than eating prose.
        malformed='Etymology tree\nProto-Indo-European *foo\nThe story continues.\nEnglish example'
        self.assertEqual(clean_display(malformed,'example'),(malformed,[]))

    def test_haha_laughter_explanation_is_retained_per_etymology(self):
        text=('From Middle English haha, ha ha, from Old English ha ha (interjection), '
              'ultimately onomatopoeic. Compare Old Frisian haha (interjection), '
              'Middle Low German hahā, hahahā (interjection), Middle High German '
              'hahā, haha (interjection), all expressions of joy or of laughter.')
        result=evaluate(text,'haha')
        self.assertIsNone(result['reason'])
        self.assertEqual(result['text'],text)
        # The same headword's bare borrowing remains a separate decision.
        self.assertEqual(evaluate('Borrowed from Hawaiian hāhā.','haha')['reason'],
                         'provenance_only')

    def test_pie_marker_does_not_remove_inline_roots(self):
        text='PIE word\n *h₁én\nFrom a source with Proto-Indo-European *h₁én in its explanation.'
        self.assertEqual(clean_display(text)[0],'From a source with Proto-Indo-European *h₁én in its explanation.')
        narrative='PIE word\n* This is an explanatory list item.'
        self.assertEqual(clean_display(narrative),(narrative,[]))



if __name__=='__main__':unittest.main()
