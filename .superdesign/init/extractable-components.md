# Extractable components

#### Layout Components
## TopHeader
- Source: `app/layout.tsx` (header.top)
- Category: layout
- Description: Brand mark + 'Uniparty', '119th Congress' tag, lede, Senate/House party counts
- Extractable props: none
- Hardcoded: inline SVG brand mark, text, counts

## RosterRail
- Source: `components/RosterRail.tsx`
- Category: layout
- Description: Sticky left rail with member search, chamber/party segmented filters and a member list
- Extractable props: selectedId (string, default: "P000197")
- Hardcoded: labels, placeholder, list rows

## Footer
- Source: `app/layout.tsx` (footer)
- Category: layout
- Description: Data-source explanation paragraph

#### Basic Components
## Provenance
- Source: `components/Provenance.tsx`
- Category: basic
- Description: 'X from <source> · Pulled <date> · checked daily' line
- Extractable props: what (string), source (string), pulled (string)
