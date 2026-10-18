# Pages

## /members/[id] (Member profile)
Entry: `app/members/[id]/page.tsx`
Dependencies:
- `app/layout.tsx`
  - `components/RosterRail.tsx`
- `components/RecentVotes.tsx`
  - `components/Provenance.tsx`
- `components/Bills.tsx`
  - `components/Provenance.tsx`
- `components/Provenance.tsx`
- `app/globals.css`
- (logic only) `lib/data.ts`, `lib/format.ts`, `lib/types.ts`, `lib/ingest/votes.ts`

## / (Home)
Entry: `app/page.tsx`
Dependencies:
- `app/layout.tsx`
  - `components/RosterRail.tsx`
- `components/Provenance.tsx`
- `app/globals.css`
