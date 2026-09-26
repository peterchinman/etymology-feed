# Decisions

## 2026-09-25 — Product name and domain (§12)

Use **Etymology Feed** as the product name. Target **etymologyfeed.com** for the
custom domain in M5; confirm availability before registration. Neither choice
affects the data or API design.

## 2026-09-25 — Anonymous sign-in nudge (§12)

Show the suggested “sign in to save” nudge once after 10 likes. The persistent
anonymous banner on the Liked screen remains as specified in §7.1.

## 2026-09-25 — M1 wild feed sampling (§4.2, §10)

On the 500-word D1 fixture, fetching 100 random shuffle positions through
`json_each` read 301 rows. An indexed range of 100 positions read 100 rows.
M1 therefore picks a uniform random start in the dictionary's shuffled order
and reads 100 consecutive positions, wrapping at the end. Every word has the
same 100/N inclusion probability. With the one-row `meta` lookup, a fetch reads
101 rows, meeting the free-plan budget. M3's scored pools and served filtering
will be measured separately.

## 2026-09-26 — M2 offline shell (§3.1, §7.4, §10)

Use the spec's hand-written service-worker option. The build lists and hashes
every generated shell file, then writes `sw.js` with that precache. HTML is
network-first; static assets are cache-first; `/api/*`, `/auth/*`, and `/healthz`
are excluded. This keeps the PWA shell independent of a new build dependency.
The anonymous banner's sign-in control stays disabled until M4 adds providers.

## 2026-09-26 — M2 semantic visual system

Use five reusable typography roles: `display-voice` for words and headings,
`reading-voice` for etymologies and definitions, `body-voice` for sentences and
status, `label-voice` for short controls and navigation, and `caption-voice` for
source credit. “Instructive” was too narrow for controls, while “quiet” made
primary mobile navigation sound secondary. Icon glyphs use size tokens rather
than a text voice. Components select a role and may adjust its size through a
role custom property; they do not define their own font stacks or weights. The
single stylesheet groups color, type, spacing, surface, layout, and motion
tokens at the root, with dark-theme and narrow-layout overrides. Source CSS
contains no pixel literals. The two layout breakpoints use `rem`, since CSS
custom properties cannot be used in media queries.

## 2026-09-26 — M2 RWG theme family

Use the four [Random Word Generator themes](https://github.com/peterchinman/random-word-generator-site/blob/master/src/styles/style.css):
pink/blue palettes crossed with light/dark modes. The default pink palette
follows the device mode until the visitor explicitly toggles dark mode. Match
RWG's canvas, raised surface, accent, border, and shadow colors; map them through
the site's semantic tokens and use Georgia serif for all five voices instead of
RWG's Roboto Mono.
Blue-light raised text uses white rather than RWG's pale lilac so small text
meets contrast requirements. Keep palette and mode in IndexedDB, mirror them in
localStorage for the pre-paint theme, and honor the old light/dark preference.

## 2026-09-26 — M2 dictionary attribution placement

Remove the visible credit line from Feed and Liked cards. Link each word heading
to its original Wiktionary entry, and place the contributor, extraction,
adaptation, and CC BY-SA 4.0 notice in Settings. The [license](https://creativecommons.org/licenses/by-sa/4.0/legalcode)
allows attribution in a manner reasonable for the medium and context, while
asking for a link to the source material where practical. This keeps direct
entry links available and the credit accessible without repeating it on every
card. This user-requested placement replaces the per-card line in SPEC §3 and
§7.4; it does not change the dictionary's license.
