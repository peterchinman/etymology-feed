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
