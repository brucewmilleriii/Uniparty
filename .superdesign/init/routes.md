# Routes (Next.js App Router, file-based)

| Path | File | Layout | Renders |
|---|---|---|---|
| `/` | `app/page.tsx` | `app/layout.tsx` | Welcome card: 'Find your representatives' + provenance |
| `/members/[id]` | `app/members/[id]/page.tsx` | `app/layout.tsx` | Member profile: header card (party pill, district, name, facts, source links), Recent votes, Bills, Committees, 'More records' card linking to FEC, stock disclosures and full voting record |
| 404 | `app/not-found.tsx` | `app/layout.tsx` | Not found card |

`[id]` is the Bioguide id, e.g. `/members/P000197` (Nancy Pelosi).
