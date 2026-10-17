# Uniparty

A public tracker for federal and state representatives: votes, campaign money, stock trades, bills sponsored and recent storylines.

This version lists all 539 sitting members of Congress with their seat, term and committee assignments, and each member's positions on the 50 most recent roll-call votes in their chamber, with attendance. Profiles link to the official records for bills, money and trades, which get their own ingest steps next.

## Run it

```sh
npm install
npm run dev          # http://localhost:3000
npm test             # unit tests for the ingest
npm run build
```

No keys are needed to run locally: the site reads the committed snapshot in `data/roster.json`.

## Keeping the data current and correct

Every dataset follows the same rules, so the site never shows a number it can't trace back to an official record.

1. **Primary sources only.** Votes from the House Clerk and Senate.gov, bills from Congress.gov, money from the FEC, trades from STOCK Act filings, the roster from [congress-legislators](https://github.com/unitedstates/congress-legislators) (which is itself compiled from those offices). No scraped aggregators.
2. **Provenance on every record.** Each row stores the `source_url` it came from and the `fetched_at` time, and the snapshot stores a SHA-256 of each source file. Every page shows where its data came from and when it was pulled.
3. **Validate before publishing.** `lib/ingest/roster.ts` rejects a roster that looks wrong (fewer than 95 senators, more than two per state, more than 435 voting House members, two members in one seat, duplicate ids, expired terms, a senator with no LIS id). `lib/ingest/votes.ts` rejects any roll call whose recorded positions don't add up to the chamber's official Yea/Nay/Present/Not Voting totals, that lists too few members, records anyone twice, or names senators missing from the roster. A failed check exits non-zero and keeps the previous good data.
4. **Scheduled refresh.** `.github/workflows/refresh-roster.yml` runs daily and `.github/workflows/refresh-votes.yml` twice a day. When the source changed, the job commits the new snapshot, which redeploys the site. When validation fails the job fails, and GitHub emails the repo owner. Pull requests that change the votes ingest run it against the live sources in check-only mode.
5. **Health check.** `GET /api/health` returns the roster size, the vote count, the latest vote date per chamber and when each was last pulled, for an uptime monitor.

## Architecture

| Piece | Where |
| --- | --- |
| Web app | Next.js (App Router) in `app/`, hosted on Vercel |
| Data access | `lib/data.ts`: Supabase when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, otherwise `data/roster.json` and `data/votes.json` |
| Ingest | `scripts/ingest-roster.ts` and `scripts/ingest-votes.ts` (fetch, hash, validate, write) and `lib/ingest/` |
| Database | Supabase Postgres, schema in `supabase/migrations/` |
| Refresh | GitHub Actions on a daily schedule |

## Setting up hosting and the database

**Vercel.** Import this repo at vercel.com/new. No build settings to change. Add the Supabase env vars below once the database exists.

**Supabase.** Create a project, then run the files in `supabase/migrations/` in order in the SQL editor (or `supabase db push`). Then add:

- To Vercel: `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- To GitHub repo secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, so the daily job also writes to the database.

**API keys** for the next ingest steps go in Vercel and GitHub secrets, never in the browser: `DATA_GOV_API_KEY` (Congress.gov and FEC, free at api.data.gov) and `OPENSTATES_API_KEY` (state legislators). See `.env.example`.

## Refreshing by hand

```sh
npm run ingest:roster            # fetch from the source
npm run ingest:roster -- --force # rewrite even if the source is unchanged
npm run ingest:votes             # fetch new roll calls (votes already in the snapshot aren't refetched)
npm run ingest:votes -- --check  # fetch and validate only, write nothing
npm run ingest:votes -- --force  # refetch the whole window
```

Run `ingest:roster` before `ingest:votes` when membership changes: Senate.gov identifies senators only by LIS id, and the roster supplies the mapping to bioguide ids.

## How votes are pulled

- **House:** `clerk.house.gov/evs/{year}/roll{NNN}.xml`. Roll calls are numbered per calendar year without gaps, so the ingest finds the newest by probing (a missing roll comes back as HTTP 200 with an error document, which the ingest recognises).
- **Senate:** the session's list at `senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml`, then each vote's XML.
- The 50 most recent roll calls per chamber are kept in `data/votes.json`, each with its source URL, SHA-256 and fetch time. Positions are stored exactly as the chamber recorded them ("Aye" and "No" on House recorded votes, candidate names when electing a Speaker). With Supabase configured, older votes stay in the database as history.
