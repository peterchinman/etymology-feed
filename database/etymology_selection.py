"""Accepted provenance selection after three editorial review rounds."""
import json
import re

import etymology_rules as provenance_rules

LANG = provenance_rules.LANG.replace('Early|Late|', 'Lebanese|Mexican|Early|Late|')
LANG_START = re.compile(r'^(?:a\s+)?' + LANG + r'(?:\s+language)?\b', re.I)
ORIGIN = re.compile(
    r'^(?:(?:Ultimately|Possibly|Probably)\s+)*(?:From|Via|Romanization of|(?:Learned |Unadapted )?(?:borrowing|borrowed) from|'
    r'Inherited from|Derived from|(?:Partial )?calque of|Singular of)\s+', re.I,
)
FOLLOWUP = re.compile(r'^(?:(?:Possibly|Probably)\s+)?(?:Doublet of|Compare|Cognate with|Variant of)\s+', re.I)
REFERENCE = re.compile(r'^(?:the )?(?:noun|verb|adjective|adverb)(?:\s*\(see (?:above|below)\))?$', re.I)
ROMANIZATION = re.compile(
    r'^(?:the )?(?:atonal )?(?:Hanyu Pinyin|Pinyin|Wade[–-]Giles) romanization of (?:the )?', re.I,
)


def lexical(text):
    text = text.strip()
    affix = LANG_START.sub('', text, count=1).strip().rstrip('.')
    if re.fullmatch(r'(?:-[^\W\d_]+-?|[^\W\d_]+-)', affix):
        return True
    # Only strip recognized dialect labels immediately before a source language.
    text = re.sub(r'^Lebanese\s+(?=Arabic\b)', '', text, flags=re.I)
    text = re.sub(r'^Mexican\s+(?=Spanish\b)', '', text, flags=re.I)
    # Tibetan tsheg separates syllables within native-script source forms.
    # Normalize it only for recognition; the displayed source is untouched.
    text = text.replace('་', '-').replace('༌', '-')
    return provenance_rules.lexical(text.replace('／', '/'))


def form_list(text):
    return all(piece and lexical(piece)
               for piece in provenance_rules.split_outside(text, r',\s*|\s+(?:or|and)\s+'))


def morph(text):
    if provenance_rules.morph(text):
        return True
    text = re.sub(r'^(?:From|Equivalent to|By surface analysis,?)\s+', '', text, flags=re.I).strip().rstrip('.')
    parts = provenance_rules.split_outside(text, r'\s*\+\s*')
    return len(parts) > 1 and all(part and form_list(part) for part in parts)


def source_piece(text):
    if REFERENCE.fullmatch(text):
        return True
    tribal = re.fullmatch(r'the (?:local )?tribe of (?:the )?(.+)', text, re.I)
    if tribal:
        return lexical(tribal[1])
    text = ROMANIZATION.sub('', text)
    return morph(text) or form_list(text)


def bare_provenance(text):
    """Require every sentence and source-chain component to be recognized."""
    if provenance_rules.GLOSS.search(text):
        return False
    if provenance_rules.provenance(text):
        return True
    text = re.sub(r',?\s*q\.v\.', '', text, flags=re.I).strip()
    # Expand the abbreviation before sentence splitting (the period is not a boundary).
    text = re.sub(r'\bcf\.\s+', 'Compare ', text, flags=re.I)
    text = re.sub(r'^Originated\s+\d{3,4}(?:[–-]\d{2,4})?\s+from\s+', 'From ', text, flags=re.I)
    # This replaces only an entire surname/variant statement, not name histories.
    surname = re.fullmatch(r'(' + LANG + r') surname \(([^()]+)\), variant of (.+?)\.?', text, re.I)
    if surname and lexical(surname[2]) and lexical(surname[3]):
        return True
    has_origin = False
    for n, sentence in enumerate(provenance_rules.split_outside(text, r'\.\s+|;\s*')):
        sentence = sentence.strip().rstrip('.')
        if not sentence:
            continue
        if n == 0 and sentence.lower() in ('unknown', 'origin unknown', 'of unknown origin'):
            has_origin = True
            continue
        if re.fullmatch(r'(?:(?:Ultimately|Possibly|Probably)\s+)*[Oo]f\s+' + LANG + r'\s+origin', sentence, re.I):
            has_origin = True
            continue
        surname_reference = re.fullmatch(r'From the (' + LANG + r') surname, variant of (.+)', sentence, re.I)
        if surname_reference and lexical(surname_reference[2]):
            has_origin = True
            continue
        reference = re.fullmatch(r'(?:See|More at)\s+(.+)', sentence, re.I)
        if reference and lexical(reference[1]):
            has_origin = True
            continue
        sentence = re.sub(r'^The (?:noun|verb|adjective|adverb) is from\s+', 'From ', sentence, flags=re.I)
        if morph(sentence):
            has_origin = True
            continue
        origin = (ORIGIN.match(sentence) or provenance_rules.SPELLING.match(sentence)
                  or re.match(r'^(?:Americanized|Anglicized) spelling of\s+', sentence, re.I))
        if origin:
            tail = sentence[origin.end():]
        elif n > 0 and (followup := FOLLOWUP.match(sentence)):
            if not form_list(sentence[followup.end():]):
                return False
            continue
        elif LANG_START.match(sentence):
            tail = sentence
        else:
            return False
        has_origin = True
        tail = re.sub(r',?\s*of (?:uncertain|unknown) origin$', '', tail, flags=re.I)
        pieces = provenance_rules.split_outside(
            tail, r',?\s+(?:and\s+)?(?:(?:ultimately|possibly|probably)\s+)?(?:from|through|via)\s+|\s+and its etymon\s+|,\s*(?:variant of\s+)|,\s*(?=equivalent to\b)',
        )
        if not all(piece and source_piece(piece) for piece in pieces):
            return False
    return has_origin


def without_source_glosses(text):
    """Strip quoted meanings only inside lexical parentheticals for classification.

    Narrative quotations, 'literally' prose, and naming explanations remain and
    prevent exclusion. This is intentionally narrower than deleting all quotes.
    """
    def replace(match):
        inner = match[1]
        if not provenance_rules.GLOSS.search(inner):
            return match[0]
        remainder = provenance_rules.GLOSS.sub('', inner).strip().strip(',').strip()
        if not remainder:
            return ''
        if lexical(remainder):
            return '(' + remainder + ')'
        return match[0]
    return re.sub(r'\(([^()]*)\)', replace, text)


def proper_only(card):
    pos = card.get('pos', [])
    if isinstance(pos, str):
        pos = json.loads(pos)
    return card.get('def_pos') == 'proper noun' and set(pos) == {'proper noun'}


def exclusion_reason(card):
    text = card['etymology']
    if bare_provenance(text):
        return 'expanded_bare_provenance'
    if proper_only(card) and provenance_rules.GLOSS.search(text):
        stripped = without_source_glosses(text)
        if stripped != text and bare_provenance(stripped):
            return 'proper_noun_glossed_provenance'
    return None
