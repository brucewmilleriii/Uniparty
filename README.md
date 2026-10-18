# Uniparty

A public tracker for federal and state representatives: votes, campaign money, stock trades, bills sponsored and recent storylines.

This version lists all 539 sitting members of Congress with their seat, term and committee assignments, each member's positions on the 50 most recent roll-call votes in their chamber, with attendance, and the bills and resolutions they sponsored and cosponsored in the current Congress. Profiles link to the official records for money and trades, which get their own ingest steps next.

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
3. **Validate before publishing.** `lib/ingest/roster.ts` rejects a roster that looks wrong (fewer than 95 senators, more than two per state, more than 435 voting House members, two members in one seat, duplicate ids, expired terms, a senator with no LIS id). `lib/ingest/votes.ts` rejects any roll call whose recorded positions don't add up to the chamber's official Yea/Nay/Present/Not Voting totals, that lists too few members, records anyone twice, or names senators missing from the roster. `lib/ingest/bills.ts` rejects a member's bill list that ends short of the count Congress.gov reports, is out of Congress order, repeats a bill, or holds anything that isn't a well-formed bill; rejects a snapshot where a bill has two sponsors or a member's sponsored count went down within a Congress; and re-reads a random sample of bills from each bill's own record to confirm the sponsor, cosponsors and dates. A failed check exits non-zero and keeps the previous good data.
4. **Scheduled refresh.** `.github/workflows/refresh-roster.yml` and `.github/workflows/refresh-bills.yml` run daily and `.github/workflows/refresh-votes.yml` twice a day. When the source changed, the job commits the new snapshot, which redeploys the site. When validation fails the job fails, and GitHub emails the repo owner. Pull requests that change the votes or bills ingest run it against the live sources in check-only mode.
5. **Health check.** `GET /api/health` returns the roster size, the vote count, the latest vote date per chamber, the bill count and when each was last pulled, for an uptime monitor.

## Architecture

| Piece | Where |
| --- | --- |
| Web app | Next.js (App Router) in `app/`, hosted on Vercel |
| Data access | `lib/data.ts`: Supabase when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, otherwise `data/roster.json`, `data/votes.json` and `data/bills.json` |
| Ingest | `scripts/ingest-roster.ts`, `scripts/ingest-votes.ts` and `scripts/ingest-bills.ts` (fetch, hash, validate, write) and `lib/ingest/` |
| Database | Supabase Postgres, schema in `supabase/migrations/` |
| Refresh | GitHub Actions on a daily schedule |

## Setting up hosting and the database

**Vercel.** Import this repo at vercel.com/new. No build settings to change. Add the Supabase env vars below once the database exists.

**Supabase.** Create a project, then run the files in `supabase/migrations/` in order in the SQL editor (or `supabase db push`). Then add:

- To Vercel: `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- To GitHub repo secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, so the daily job also writes to the database.

**API keys** go in GitHub secrets (and Vercel, if a page ever needs them), never in the browser. `DATA_GOV_API_KEY` (free at [api.data.gov/signup](https://api.data.gov/signup/)) is needed for bills now and the FEC later; until it is added, the bills job skips with a warning. `OPENSTATES_API_KEY` is for state legislators later. See `.env.example`.

## Refreshing by hand

```sh
npm run ingest:roster            # fetch from the source
npm run ingest:roster -- --force # rewrite even if the source is unchanged
npm run ingest:votes             # fetch new roll calls (votes already in the snapshot aren't refetched)
npm run ingest:votes -- --check  # fetch and validate only, write nothing
npm run ingest:votes -- --force  # refetch the whole window
npm run ingest:bills             # needs DATA_GOV_API_KEY
npm run ingest:bills -- --check --members 25  # validate the first 25 members, write nothing
```

Run `ingest:roster` before `ingest:votes` when membership changes: Senate.gov identifies senators only by LIS id, and the roster supplies the mapping to bioguide ids.

## How votes are pulled

- **House:** `clerk.house.gov/evs/{year}/roll{NNN}.xml`. Roll calls are numbered per calendar year without gaps, so the ingest finds the newest by probing (a missing roll comes back as HTTP 200 with an error document, which the ingest recognises).
- **Senate:** the session's list at `senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml`, then each vote's XML.
- The 50 most recent roll calls per chamber are kept in `data/votes.json`, each with its source URL, SHA-256 and fetch time. Positions are stored exactly as the chamber recorded them ("Aye" and "No" on House recorded votes, candidate names when electing a Speaker). With Supabase configured, older votes stay in the database as history.

## How bills are pulled

- For each sitting member, `api.congress.gov/v3/member/{bioguideId}/sponsored-legislation` and `/cosponsored-legislation`, 250 items a page. Both lists are grouped by Congress, newest Congress first, so paging stops at the first item from an earlier Congress. Within a Congress they are not in date order, so the ingest sorts them itself and checks only that the Congress order holds. The key is sent as the `X-Api-Key` header, so it never appears in a stored URL.
- Counts cover bills and resolutions in the current Congress. Amendments appear in the sponsored list but aren't counted. For cosponsored bills Congress.gov's date is the day the member signed on, which can be long after the bill was introduced, and the profile labels it that way.
- `data/bills.json` keeps each member's 10 most recent sponsored and cosponsored bills, every API page's URL and SHA-256, and the fetch time. A full run is about 1,100 to 2,000 API calls, well inside api.data.gov's 5,000 an hour.
- With Supabase configured, bills that leave the window stay in the database as history.
