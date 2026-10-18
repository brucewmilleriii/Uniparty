# Uniparty design system

## Product
Uniparty is a public, nonpartisan tracker for every member of Congress (federal now, states later). A member profile shows: seat and term facts, recent roll-call votes, campaign money (FEC), stock trades (STOCK Act disclosures), bills sponsored/cosponsored, committees, and recent storylines. Election mode will compare candidates side by side.
Audience: curious voters, journalists, watchdogs. Web first, mobile app later.
Core rule: every fact is sourced. Each dataset shows a provenance line ("<Dataset> from <Source> · Pulled <date> · checked daily") and links to the official record. Never show invented data.

## Key pages
- Member profile `/members/[id]` (primary design target)
- Home / roster search `/`
- Shell: top header (brand, 119th Congress tag, party counts) + left roster rail (search, chamber and party filters, member list) + member file on the right.

## Current visual style ("records-office ledger")
- Colors: paper #EEF1F4 bg, white sheets, ink #132030 / #4A5868 / #7A8796, rules #D5DBE2 / #E5E9EE, gold highlight #F2C14E (soft #FBEFC9), party colors Dem #2457B5, Rep #BE3A2E, Ind #6F4BB0. Dark mode supported.
- Type: Public Sans for UI (headlines 800 weight, tight tracking); IBM Plex Mono for data, dates, roll numbers and uppercase eyebrow labels.
- Shape: 6px card radius, 3–4px chips, 1px rules, no shadows. Max width 1240px; rail 320px.
- Votes: Yea = solid ink chip, Nay = dashed outline chip, Not voting = faint outline. Tally bar shows chamber Yea share.

## Requirements every direction keeps
- Party is shown with the party color but the page itself stays nonpartisan in tone.
- Data density is a feature; tables must stay legible, with tabular numerals for money and counts.
- Provenance line under every section; source links visible.
- Responsive down to 375px wide.
- Accessible contrast (WCAG AA), light background unless a direction specifies dark.

## Visual directions under exploration
Each exploration direction may define its own palette and fonts (stated in its prompt); within a direction use only what that prompt names.
