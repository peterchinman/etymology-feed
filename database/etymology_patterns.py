"""Shared lexical patterns for dictionary selection."""

import re

# Entire entry must be a construction formula. Spaces inside a part allow
# "di- + keto acid"; a colon, semicolon, or second sentence makes it a story.
PART = r"[\w‘’'\"“”()\-]+(?:\s+[\w‘’'\"“”()\-]+)*"
MORPH_RE = re.compile(
    rf"^(?:(?:From|Equivalent to|Formed from|Formed as)\s+)?"
    rf"{PART}(?:\s*\+\s*{PART})+\??\.?(?:\s+See\s+[^.]+\.?)?$",
    re.I | re.U,
)

# Source-language and historical-period names, not a general word-shape filter.
# Names are matched as whole phrases. Proto-* names are handled separately.
# Multi-word names must be preserved; the display list is intentionally explicit.
LANGUAGE_NAMES = (
    "Abkhaz", "Adyghe", "Afrikaans", "Albanian", "Amharic", "Ancient Egyptian",
    "Ancient Greek", "Anglo-Norman", "Anglo-Saxon", "Arabic", "Aramaic",
    "Armenian", "Assamese", "Avestan", "Azerbaijani", "Basque", "Belarusian",
    "Bengali", "Berber", "Breton", "Bulgarian", "Burmese", "Catalan", "Cebuano",
    "Chichewa", "Chinese", "Classical Chinese", "Classical Latin", "Coptic",
    "Cornish", "Croatian", "Czech", "Danish", "Dutch", "Early Modern English",
    "Egyptian", "English", "Esperanto", "Estonian", "Etruscan", "Faroese",
    "Finnish", "Flemish", "French", "Frisian", "Galician", "Georgian",
    "German", "Gothic", "Greek", "Gujarati", "Haitian Creole", "Hausa",
    "Hawaiian", "Hebrew", "Hindi", "Hittite", "Hungarian", "Icelandic",
    "Igbo", "Indonesian", "Irish", "Italian", "Japanese", "Javanese",
    "Kannada", "Kazakh", "Khmer", "Korean", "Kurdish", "Latin", "Latvian",
    "Lithuanian", "Low German", "Malay", "Malayalam", "Maltese", "Mandarin",
    "Manchu", "Maori", "Marathi", "Medieval Latin", "Middle Chinese",
    "Middle Dutch", "Middle English", "Middle French", "Middle High German",
    "Middle Irish", "Middle Low German", "Middle Persian", "Mongolian",
    "Nahuatl", "Navajo", "Nepali", "New Latin", "Norwegian", "Occitan",
    "Old Church Slavonic", "Old English", "Old French", "Old High German",
    "Old Irish", "Old Norse", "Old Persian", "Old Spanish", "Oriya",
    "Ottoman Turkish", "Pali", "Pashto", "Persian", "Phoenician", "Polish",
    "Portuguese", "Punjabi", "Quechua", "Romanian", "Russian", "Sanskrit",
    "Scots", "Scottish Gaelic", "Serbo-Croatian", "Sinhala", "Slovak",
    "Slovenian", "Somali", "Spanish", "Sumerian", "Swahili", "Swedish",
    "Syriac", "Tagalog", "Tamil", "Tatar", "Telugu", "Teochew", "Thai",
    "Tibetan", "Turkish", "Ukrainian", "Urdu", "Vietnamese", "Welsh",
    "West Frisian", "Wolof", "Yiddish", "Yoruba", "Zulu",
)
