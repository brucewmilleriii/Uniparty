# Uniparty

A public tracker for federal and state representatives: votes, campaign money, stock trades, bills sponsored and recent storylines.

This first version lists all 539 sitting members of Congress with their seat, term and committee assignments, and links each profile to the official records for votes, bills, money and trades. Those records get their own ingest steps next.

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
3. **Validate before publishing.** `lib/ingest/roster.ts` rejects a roster that looks wrong (fewer than 95 senators, more than two per state, more than 435 voting House members, two members in one seat, duplicate ids, expired terms). A failed check exits non-zero and keeps the previous good data.
4. **Scheduled refresh.** `.github/workflows/refresh-roster.yml` runs daily. When the source changed, it commits the new snapshot, which redeploys the site. When validation fails the job fails, and GitHub emails the repo owner.
5. **Health check.** `GET /api/health` returns the roster size and when it was last pulled, for an uptime monitor.

## Architecture

| Piece | Where |
| --- | --- |
| Web app | Next.js (App Router) in `app/`, hosted on Vercel |
| Data access | `lib/data.ts`: Supabase when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, otherwise `data/roster.json` |
| Ingest | `scripts/ingest-roster.ts` (fetch, hash, validate, write) and `lib/ingest/` |
| Database | Supabase Postgres, schema in `supabase/migrations/` |
| Refresh | GitHub Actions on a daily schedule |

## Setting up hosting and the database

**Vercel.** Import this repo at vercel.com/new. No build settings to change. Add the Supabase env vars below once the database exists.

**Supabase.** Create a project, then run `supabase/migrations/20261017000000_init.sql` in the SQL editor (or `supabase db push`). Then add:

- To Vercel: `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- To GitHub repo secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, so the daily job also writes to the database.

**API keys** for the next ingest steps go in Vercel and GitHub secrets, never in the browser: `DATA_GOV_API_KEY` (Congress.gov and FEC, free at api.data.gov) and `OPENSTATES_API_KEY` (state legislators). See `.env.example`.

## Refreshing the roster by hand

```sh
npm run ingest:roster            # fetch from the source
npm run ingest:roster -- --force # rewrite even if the source is unchanged
```
