"""Reviewed provenance filter and display cleanup; unknown syntax is retained."""

import re
import unicodedata

from etymology_patterns import LANGUAGE_NAMES, MORPH_RE

LANG = (
    r"(?:(?:Early|Late|Vulgar|Classical|Medieval|Modern|Middle|Old|New|Anglian|North|West|East|South)\s+)*(?:"
    + "|".join(re.escape(x) for x in sorted(LANGUAGE_NAMES, key=len, reverse=True))
    + r"|Proto-[A-Za-z-]+)"
)
LANG_START = re.compile(r"^(?:a\s+)?" + LANG + r"(?:\s+language)?\b", re.I)
GLOSS = re.compile(r'[“"][^”"\n]+[”"]|‘[^’\n]+’|(?<!\w)\x27[^\x27\n]+\x27(?!\w)')
# Reject only a small grammar of provenance statements. These prose tokens
# stop the lexical-form parser from consuming ordinary explanatory clauses.
PROSE = re.compile(
    r"\b(?:a|an|the|as|at|in|on|of|to|for|by|with|without|which|who|whose|where|when|"
    r"because|since|after|before|during|named|meaning|means|meant|literally|refers?|"
    r"reference|used|use|using|became|become|called|coined|originally|influenced|"
    r"influence|humorous|humorously|jocular|jocularly|jokingly|pun|onomatopoeic|"
    r"imitative|related|expressions?|all|perhaps|possibly|probably|uncertain|unknown|"
    r"is|was|were|are|has|have|had|not|so|this|that|it|its|their|these|those)\b", re.I,
)
BORROW = re.compile(
    r"^(?:(?:Unadapted\s+)?(?:Borrowed|Borrowing)|Inherited|Derived)\s+from\s+|^From\s+", re.I,
)
SPELLING = re.compile(
    r"^(?:(?:Possibly|Probably)\s+)?(?:an?\s+)?(?:altered\s+spelling|spelling\s+variant|"
    r"variant\s+spelling|anglicized\s+form|Americanized\s+form)\s+of\s+", re.I,
)


def is_form(text):
    words = text.split()
    return 1 <= len(words) <= 4 and all(
        unicodedata.category(ch)[0] in 'LMN' or ch in "_*'’ʹʺ-–/"
        for word in words for ch in word
    )


def split_outside(text, pattern):
    """Split matched delimiters only outside parentheses (romanizations)."""
    depth = 0
    start = 0
    out = []
    allowed = set()
    for i, ch in enumerate(text):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        elif depth == 0:
            allowed.add(i)
    for match in re.finditer(pattern, text, re.I):
        if match.start() in allowed:
            out.append(text[start:match.start()].strip())
            start = match.end()
    out.append(text[start:].strip())
    return out


def lexical(text):
    """A source form, possibly with romanization or a modern-language form."""
    text = text.strip().rstrip('.')
    parens = re.findall(r'\(([^()]*)\)', text)
    for inner in parens:
        inner = inner.strip().rstrip('.')
        if LANG_START.match(inner):
            inner = LANG_START.sub('', inner, count=1).strip()
        if not is_form(inner) or PROSE.search(inner):
            return False
    text = re.sub(r'\([^()]*\)', '', text).strip()
    if '(' in text or ')' in text:
        return False
    match = LANG_START.match(text)
    if match:
        text = text[match.end():].strip()
    return not text or bool(is_form(text) and not PROSE.search(text))


def form_list(text):
    return all(piece and lexical(piece) for piece in split_outside(text, r',\s*|\s+(?:or|and)\s+'))


def morph(text):
    text = re.sub(
        r'^(?:from|equivalent to|by surface analysis,?|morphologically|see)\s+',
        '', text, flags=re.I,
    ).strip().rstrip('.')
    if '+' not in text or not MORPH_RE.fullmatch(text):
        return False
    # Formula components are forms, not arbitrary prose on either side of +.
    return all(lexical(part) or bool(re.fullmatch(r'-?\w+-', part.strip()))
               for part in text.split('+'))


def provenance(text):
    """Return an exclusion reason only when every clause is bare provenance."""
    if GLOSS.search(text):
        return None
    text = re.sub(r',?\s*q\.v\.', '', text, flags=re.I).strip()
    sentences = split_outside(text, r'\.\s+|;\s*')
    has_language = bool(re.search(LANG, text, re.I))
    has_origin = False
    has_morph = False
    for n, sentence in enumerate(sentences):
        sentence = sentence.strip().rstrip('.')
        if not sentence:
            continue
        if morph(sentence):
            has_morph = True
            continue
        source = BORROW.match(sentence) or SPELLING.match(sentence)
        if source:
            has_origin = True
            tail = sentence[source.end():]
        elif n > 0 and re.match(r'^(?:Doublet of|Compare|Cognate with)\s+', sentence, re.I):
            tail = re.sub(r'^(?:Doublet of|Compare|Cognate with)\s+', '', sentence, flags=re.I)
            if not form_list(tail):
                return None
            continue
        else:
            return None
        tail = re.sub(r',?\s*of (?:uncertain|unknown) origin$', '', tail, flags=re.I)
        pieces = split_outside(
            tail, r',?\s+(?:and\s+)?(?:ultimately\s+)?from\s+|\s+and its etymon\s+|,\s*(?=equivalent to\b)',
        )
        for piece in pieces:
            if morph(piece):
                has_morph = True
            elif not form_list(piece):
                return None
    if has_origin and has_language:
        return 'provenance_plus_morphology' if has_morph else 'provenance_only'
    return None


def clean_display(text, word=None):
    """Remove only marked root/tree blocks, preserving the following prose."""
    lines = text.splitlines()
    output = []
    removed = []
    i = 0
    while i < len(lines):
        if (lines[i].strip() == 'PIE word' and i + 1 < len(lines)
                and re.fullmatch(r'\s*\*\S+(?:\s+\([^\n]*\))?\s*', lines[i + 1])):
            removed.extend(lines[i:i + 2])
            i += 2
            continue
        if lines[i].strip() == 'Etymology tree':
            # The flattened template ends at its English headword node. This
            # boundary handles unknown language names, branch arrows, and
            # inline labels such as "bor." without guessing from text length.
            j = i + 1
            end = None
            while word and j < len(lines):
                line = lines[j].strip()
                if re.fullmatch(r'English\s+' + re.escape(word) + r'\s*[.+]?', line):
                    end = j + 1
                    break
                if line == 'Etymology tree' or re.match(
                    r'^(?:From\b|Borrowed\b|Inherited\b|Derived\b|The\s|Named\b|Coined\b|'
                    r'Learned borrowing\b|Spelling pronunciation\b)', line,
                ):
                    break
                j += 1
            if end is not None:
                removed.extend(lines[i:end])
                i = end
                continue
        output.append(lines[i])
        i += 1
    return '\n'.join(output).strip(), removed


def evaluate(text, word=None):
    cleaned, removed = clean_display(text, word)
    return {'text': cleaned, 'reason': provenance(cleaned), 'removed_lines': removed}
