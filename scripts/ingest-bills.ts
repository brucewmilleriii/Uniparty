/*
 * Fetch every sitting member's sponsored and cosponsored bills for the current
 * Congress from the Congress.gov API, validate them, and write data/bills.json.
 * A sample of bills is re-read from each bill's own record to confirm the
 * sponsor and cosponsors match. When SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * are set it also upserts into Supabase.
 *
 * Needs DATA_GOV_API_KEY (free at https://api.data.gov/signup/). Congress.gov's
 * member lists aren't ordered by date or Congress, so every page of every list is
 * read; requests are paced under the key's hourly limit, so a full run takes a while.
 *
 *   npm run ingest:bills                         # fetch from the source
 *   npm run ingest:bills -- --check              # fetch and validate only; write nothing
 *   npm run ingest:bills -- --check --members 25 # same, for the first 25 members only
 *   npm run ingest:bills -- --force              # write even if nothing changed
 *
 * Exits non-zero, leaving the existing snapshot untouched, if anything fails validation.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  API_BASE,
  BILLS_SOURCE,
  BILL_WINDOW,
  billCosponsorsUrl,
  billUrl,
  checkCosponsor,
  checkSponsor,
  cosponsorsNext,
  itemKey,
  memberLegislationUrl,
  parseLegislation,
  readLegislationPage,
  readWholeList,
  toMemberBills,
  validateBillsSnapshot,
  type LegislationKind,
  type LegislationPage,
  type ParsedLink,
} from "../lib/ingest/bills";
import { congressForYear } from "../lib/ingest/votes";
import { writeBillsToSupabase } from "../lib/ingest/supabase-writer";
import type { Bill, BillsSnapshot, MemberBills, RosterSnapshot } from "../lib/types";

const OUT = path.join(process.cwd(), "data", "bills.json");
const ROSTER = path.join(process.cwd(), "data", "roster.json");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes("--check");
const force = process.argv.includes("--force");
const memberLimit = arg("--members") ? Number(arg("--members")) : Infinity;
/** Overridable only to point the script at a local mock in testing. */
const base = process.env.CONGRESS_API_BASE ?? API_BASE;
const fetchedAt = new Date().toISOString();
const { congress } = congressForYear(new Date().getUTCFullYear());

/** Bills re-checked against their own record each run, per kind. */
const SAMPLE = 12;
const CONCURRENCY = 4;
/**
 * Calls per hour this job allows itself. api.data.gov allows 5,000 an hour per key,
 * and the same key serves the FEC ingest, so this leaves room for it.
 */
const HOURLY_BUDGET = 4200;
/** Wait for the key's hourly allowance to recover when fewer calls than this are left. */
const RESERVE = 400;

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

let latest = Infinity;
let nextSlot = 0;
let calls = 0;

/** Space requests evenly at HOURLY_BUDGET an hour, and back off when the key is nearly spent. */
async function pace() {
  const now = Date.now();
  if (latest < RESERVE) {
    // Push the shared slot back, so every worker waits, not just this one.
    console.log(`Only ${latest} API calls left on the key this hour; waiting 5 minutes.`);
    latest = Infinity;
    nextSlot = Math.max(nextSlot, now + 300_000);
  }
  const at = Math.max(now, nextSlot);
  nextSlot = at + 3_600_000 / HOURLY_BUDGET;
  if (at > now) await sleep(at - now);
}

/** GET JSON with retries on rate limiting and server errors; returns null on 404. */
async function get(url: string): Promise<{ body: unknown; text: string } | null> {
  // Each kind of failure has its own budget, so waiting out rate limits doesn't use up the retries for a blip.
  let limited = 0;
  let serverErrors = 0;
  let networkErrors = 0;
  for (;;) {
    await pace();
    calls++;
    let res: Response;
    try {
      res = await fetch(url, { headers: { "X-Api-Key": key!, Accept: "application/json", "User-Agent": "uniparty-ingest (+https://github.com/brucewmilleriii/uniparty)" } });
    } catch (err) {
      if (++networkErrors >= 3) throw err;
      await sleep(2000 * networkErrors);
      continue;
    }
    const left = Number(res.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(left)) latest = left;
    if (res.status === 404) return null;
    if (res.status === 403) throw new Error(`${publicUrl(url)} returned HTTP 403; check that DATA_GOV_API_KEY is valid`);
    if (res.status === 429) {
      // Out of calls for the hour: make every worker wait 5 minutes, for up to an hour.
      if (++limited >= 12) throw new Error(`${publicUrl(url)} was still rate limited after ${limited} tries`);
      latest = 0;
      continue;
    }
    if (res.status >= 500) {
      if (++serverErrors >= 4) throw new Error(`${publicUrl(url)} returned HTTP ${res.status} after ${serverErrors} tries`);
      await sleep(5000 * serverErrors);
      continue;
    }
    if (!res.ok) throw new Error(`${publicUrl(url)} returned HTTP ${res.status}`);
    // A cut-off body or a 200 carrying a maintenance page counts as a network error.
    try {
      const text = await res.text();
      return { body: JSON.parse(text), text };
    } catch (err) {
      if (++networkErrors >= 3) throw new Error(`${publicUrl(url)} didn't return a readable JSON body after ${networkErrors} tries: ${err instanceof Error ? err.message : err}`);
      await sleep(2000 * networkErrors);
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

const errors: string[] = [];
const missing: string[] = [];

let reReadLists = 0;
let extraReads = 0;

/** Read one member list in full; see readWholeList for how gaps are filled. */
async function fetchList(id: string, kind: LegislationKind, sources: MemberBills["sources"]): Promise<LegislationPage[] | null> {
  const list = await readWholeList(`${id} ${kind}`, async (offset) => {
    const url = memberLegislationUrl(id, kind, offset, base);
    const res = await get(url);
    return res && { page: readLegislationPage(res.body, kind), source: { url: publicUrl(url), sha256: sha(res.text) } };
  });
  if (!list) return null;
  if (list.reads > 1) reReadLists++;
  extraReads += list.reads - 1;
  if (!list.confirmed) {
    const distinct = new Set(list.pages.flatMap((p) => p.items.map(itemKey)).filter(Boolean)).size;
    const count = list.pages[0]?.count ?? 0;
    errors.push(
      distinct < count
        ? `${id} ${kind}: still short after ${list.reads} reads (${distinct} of ${count} items)`
        : `${id} ${kind}: complete but not confirmed after ${list.reads} reads`,
    );
  }
  sources.push(...list.sources);
  return list.pages;
}

async function main() {
  const roster = JSON.parse(await readFile(ROSTER, "utf8")) as RosterSnapshot;
  const ids = roster.members.map((m) => m.bioguideId).slice(0, memberLimit);

  let prev: BillsSnapshot | null = null;
  try {
    prev = JSON.parse(await readFile(OUT, "utf8")) as BillsSnapshot;
  } catch {
    // No previous snapshot yet.
  }

  const bills: Record<string, Bill> = {};
  const members: Record<string, MemberBills> = {};
  const samples: { kind: LegislationKind; id: string; link: ParsedLink }[] = [];
  let done = 0;

  await pool(ids, async (id) => {
    const sources: MemberBills["sources"] = [];
    const sp = await fetchList(id, "sponsored", sources);
    const co = sp && (await fetchList(id, "cosponsored", sources));
    if (!sp || !co) {
      missing.push(id);
      return;
    }
    const s = parseLegislation(sp, "sponsored", id, congress);
    const c = parseLegislation(co, "cosponsored", id, congress);
    errors.push(...s.errors, ...c.errors);
    members[id] = toMemberBills(s, c, sources, fetchedAt, bills);
    for (const link of s.links) samples.push({ kind: "sponsored", id, link });
    for (const link of c.links) samples.push({ kind: "cosponsored", id, link });
    if (++done % 50 === 0) console.log(`  ${done}/${ids.length} members read`);
  });
  console.log(`Read ${done} members for the ${congress}th Congress; ${missing.length} not on Congress.gov${missing.length ? ` (${missing.join(", ")})` : ""}.`);

  // Re-read a random sample of bills from their own records.
  const pick = (kind: LegislationKind) =>
    samples
      .filter((s) => s.kind === kind)
      .map((s) => [Math.random(), s] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, SAMPLE)
      .map(([, s]) => s);
  await pool(pick("sponsored"), async ({ id, link }) => {
    const res = await get(billUrl(link.bill.congress, link.bill.type, link.bill.number, base));
    errors.push(...(res ? checkSponsor(res.body, link, id) : [`${id} sponsored ${link.bill.label}: bill record is missing`]));
  });
  await pool(pick("cosponsored"), async ({ id, link }) => {
    const pages: unknown[] = [];
    let url: string | null = billCosponsorsUrl(link.bill.congress, link.bill.type, link.bill.number, 0, base);
    while (url && pages.length < 20) {
      const res = await get(url);
      if (!res) break;
      pages.push(res.body);
      const next = cosponsorsNext(res.body);
      url = next ? next.replace(API_BASE, base) : null;
    }
    errors.push(...checkCosponsor(pages, link, id));
  });

  if (errors.length) {
    console.error(`Bills failed validation (${errors.length} problems); keeping the previous snapshot.`);
    // Group by kind of problem (ids, numbers and dates stripped) so one systematic cause stands out.
    const kinds = new Map<string, number>();
    for (const e of errors) {
      const k = e.replace(/^\S+ (sponsored|cosponsored)?:?/, "").replace(/\d[\d-]*/g, "#").trim();
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.error(`  ${n}× ${k}`);
    console.error("First problems:");
    for (const e of errors.slice(0, 30)) console.error(`  - ${e}`);
    process.exit(1);
  }

  const snapshot: BillsSnapshot = {
    provenance: { ...BILLS_SOURCE, fetchedAt, congress, window: BILL_WINDOW },
    bills: Object.fromEntries(Object.entries(bills).sort(([a], [b]) => a.localeCompare(b))),
    members: Object.fromEntries(Object.entries(members).sort(([a], [b]) => a.localeCompare(b))),
  };
  const problems = validateBillsSnapshot(snapshot, ids, prev);
  if (problems.length) {
    console.error(`Bills snapshot failed validation; keeping the previous snapshot.`);
    for (const e of problems.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }

  const total = (k: "sponsoredCount" | "cosponsoredCount") => Object.values(members).reduce((n, m) => n + m[k], 0);
  const summary = `${Object.keys(members).length} members, ${total("sponsoredCount")} sponsored and ${total("cosponsoredCount")} cosponsorships in the ${congress}th Congress, ${Object.keys(bills).length} bills kept; ${calls} API calls made, ${reReadLists} lists read again to fill gaps (${extraReads} extra reads)`;
  if (check) {
    console.log(`Check passed: ${summary}. Nothing written.`);
    return;
  }
  // Skip the write when nothing changed, so the scheduled job only commits (and redeploys) on new data.
  const fingerprint = (s: BillsSnapshot) => Object.values(s.members).flatMap((m) => m.sources.map((x) => x.sha256)).join();
  if (prev && fingerprint(prev) === fingerprint(snapshot) && !force) {
    console.log(`No changes since ${prev.provenance.fetchedAt}; snapshot left as is.`);
  } else {
    await writeFile(OUT, JSON.stringify(snapshot, null, 1) + "\n");
    console.log(`Wrote ${summary} to ${path.relative(process.cwd(), OUT)}`);
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceKey) {
    const n = await writeBillsToSupabase(url, serviceKey, snapshot);
    console.log(`Upserted ${n} members' bills into Supabase.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
