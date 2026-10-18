/*
 * Fetch every sitting member's campaign committee totals for the current two-year
 * cycle from the FEC API, validate them, and write data/finance.json. Each
 * campaign's detailed record must add up line by line and match the FEC's batch
 * totals for the same candidate. When SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * are set it also upserts into Supabase.
 *
 * Needs DATA_GOV_API_KEY (free at https://api.data.gov/signup/).
 *
 *   npm run ingest:finance                         # fetch from the source
 *   npm run ingest:finance -- --check              # fetch and validate only; write nothing
 *   npm run ingest:finance -- --check --members 25 # same, for the first 25 members only
 *   npm run ingest:finance -- --force              # write even if nothing changed
 *
 * Exits non-zero, leaving the existing snapshot untouched, if anything fails validation.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  API_BASE,
  BATCH_SIZE,
  FINANCE_SOURCE,
  candidateTotalsUrl,
  candidatesTotalsUrl,
  fecCycle,
  isCongressionalId,
  parseCandidateTotals,
  readBatch,
  toMemberFinance,
  validateFinanceSnapshot,
  type BatchRow,
} from "../lib/ingest/finance";
import { writeFinanceToSupabase } from "../lib/ingest/supabase-writer";
import type { CampaignTotals, FinanceSnapshot, MemberFinance, RosterSnapshot } from "../lib/types";

const OUT = path.join(process.cwd(), "data", "finance.json");
const ROSTER = path.join(process.cwd(), "data", "roster.json");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes("--check");
const force = process.argv.includes("--force");
const memberLimit = arg("--members") ? Number(arg("--members")) : Infinity;
/** Overridable only to point the script at a local mock in testing. */
const base = process.env.FEC_API_BASE ?? API_BASE;
const fetchedAt = new Date().toISOString();
const cycle = fecCycle(new Date());

const CONCURRENCY = 4;

if (memberLimit !== Infinity && !check) {
  console.error("--members only works with --check; a partial snapshot would drop everyone else.");
  process.exit(1);
}

const key = process.env.DATA_GOV_API_KEY;
if (!key) {
  console.error("DATA_GOV_API_KEY is not set. Get a free key at https://api.data.gov/signup/ and add it as a repo secret.");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** The URL as stored: no key, no base override. */
const publicUrl = (url: string) => url.replace(base, API_BASE);

let remaining = Infinity;

/** GET JSON with retries on rate limiting and server errors; returns null on 404. */
async function get(url: string): Promise<{ body: unknown; text: string } | null> {
  for (let attempt = 1; ; attempt++) {
    await sleep(100);
    try {
      const res = await fetch(url, { headers: { "X-Api-Key": key!, Accept: "application/json", "User-Agent": "uniparty-ingest (+https://github.com/brucewmilleriii/uniparty)" } });
      const left = res.headers.get("x-ratelimit-remaining");
      if (left !== null && Number.isFinite(Number(left))) remaining = Math.min(remaining, Number(left));
      if (res.status === 404) return null;
      if (res.status === 403) throw new Error(`${publicUrl(url)} returned HTTP 403; check that DATA_GOV_API_KEY is valid`);
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 4) throw new Error(`${publicUrl(url)} returned HTTP ${res.status} after ${attempt} tries`);
        await sleep(Number(res.headers.get("retry-after")) * 1000 || 5000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`${publicUrl(url)} returned HTTP ${res.status}`);
      const text = await res.text();
      return { body: JSON.parse(text), text };
    } catch (err) {
      if (attempt >= 3 || (err instanceof Error && /HTTP (403|429|5\d\d)/.test(err.message))) throw err;
      await sleep(2000 * attempt);
    }
  }
}

/** Run `fn` over `items` with a few requests in flight at once. */
async function pool<T>(items: T[], fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

async function main() {
  const roster = JSON.parse(await readFile(ROSTER, "utf8")) as RosterSnapshot;
  const members = roster.members.slice(0, memberLimit).map((m) => ({ ...m, fecIds: m.fecIds.filter(isCongressionalId) }));
  const withIds = members.filter((m) => m.fecIds.length);
  const ids = [...new Set(withIds.flatMap((m) => m.fecIds))];

  let prev: FinanceSnapshot | null = null;
  try {
    prev = JSON.parse(await readFile(OUT, "utf8")) as FinanceSnapshot;
  } catch {
    // No previous snapshot yet.
  }

  const errors: string[] = [];
  const sources: FinanceSnapshot["sources"] = [];

  // Which candidates have totals this cycle, and the figures to cross-check against.
  const batch = new Map<string, BatchRow>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const asked = ids.slice(i, i + BATCH_SIZE);
    const url = candidatesTotalsUrl(asked, cycle, base);
    const res = await get(url);
    if (!res) throw new Error(`${publicUrl(url)} returned HTTP 404`);
    sources.push({ url: publicUrl(url), sha256: sha(res.text) });
    const { rows, errors: e } = readBatch(res.body, asked, cycle);
    errors.push(...e);
    for (const r of rows) batch.set(r.candidateId, r);
  }
  console.log(`${batch.size} of ${ids.length} candidate ids have ${cycle - 1}–${cycle} totals.`);

  // Each of those candidates' full breakdown.
  const totals = new Map<string, CampaignTotals>();
  let done = 0;
  await pool([...batch.keys()], async (id) => {
    const url = candidateTotalsUrl(id, cycle, base);
    const res = await get(url);
    if (!res) {
      errors.push(`${id} ${cycle}: candidate totals record is missing`);
      return;
    }
    const p = parseCandidateTotals(res.body, id, cycle, batch.get(id), { sourceUrl: publicUrl(url), sha256: sha(res.text), fetchedAt });
    errors.push(...p.errors);
    if (p.totals) totals.set(id, p.totals);
    if (++done % 100 === 0) console.log(`  ${done}/${batch.size} campaigns read`);
  });

  if (errors.length) {
    console.error(`Campaign finance failed validation (${errors.length} problems); keeping the previous snapshot.`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }

  const byMember: Record<string, MemberFinance> = {};
  for (const m of withIds) {
    const campaigns = m.fecIds.map((id) => totals.get(id)).filter((c): c is CampaignTotals => c !== undefined);
    byMember[m.bioguideId] = toMemberFinance(m, m.fecIds, campaigns, fetchedAt);
  }
  const snapshot: FinanceSnapshot = {
    provenance: { ...FINANCE_SOURCE, fetchedAt, cycle },
    sources,
    members: Object.fromEntries(Object.entries(byMember).sort(([a], [b]) => a.localeCompare(b))),
  };
  const problems = validateFinanceSnapshot(
    snapshot,
    withIds.map((m) => m.bioguideId),
    prev,
  );
  if (problems.length) {
    console.error(`Campaign finance snapshot failed validation; keeping the previous snapshot.`);
    for (const e of problems.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }

  const raised = [...totals.values()].reduce((n, c) => n + c.receipts, 0);
  const summary = `${Object.keys(byMember).length} members, ${totals.size} campaigns, $${Math.round(raised).toLocaleString("en-US")} raised in ${cycle - 1}–${cycle}; ${remaining === Infinity ? "?" : remaining} API calls left this hour`;
  if (check) {
    console.log(`Check passed: ${summary}. Nothing written.`);
    return;
  }
  // Skip the write when nothing changed, so the scheduled job only commits (and redeploys) on new data.
  const fingerprint = (s: FinanceSnapshot) =>
    `${s.provenance.cycle}:${Object.entries(s.members)
      .map(([id, m]) => `${id}=${m.campaigns.map((c) => c.sha256).join("+")}`)
      .join()}`;
  if (prev && fingerprint(prev) === fingerprint(snapshot) && !force) {
    console.log(`No changes since ${prev.provenance.fetchedAt}; snapshot left as is.`);
  } else {
    await writeFile(OUT, JSON.stringify(snapshot, null, 1) + "\n");
    console.log(`Wrote ${summary} to ${path.relative(process.cwd(), OUT)}`);
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceKey) {
    const n = await writeFinanceToSupabase(url, serviceKey, snapshot);
    console.log(`Upserted ${n} campaigns into Supabase.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
