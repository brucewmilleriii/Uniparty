/*
 * Fetch recent roll-call votes from the House Clerk and Senate.gov, validate
 * each one, and write data/votes.json. Votes already in the snapshot are kept
 * and not refetched, so a daily run only downloads what is new. When
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set it also upserts the window
 * into Supabase, where older votes accumulate as history.
 *
 *   npm run ingest:votes               # fetch from the source
 *   npm run ingest:votes -- --check    # fetch and validate only; write nothing
 *   npm run ingest:votes -- --force    # refetch every vote in the window
 *
 * Exits non-zero, leaving the existing snapshot untouched, if any vote fails validation.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  VOTE_SOURCES,
  VOTE_WINDOW,
  congressForYear,
  houseVoteUrl,
  isHouseVoteXml,
  mergeVotes,
  parseHouseVote,
  parseSenateMenu,
  parseSenateVote,
  senateMenuUrl,
  senateVoteUrl,
  toVote,
  validateVote,
  validateVotesSnapshot,
  type ParsedVote,
} from "../lib/ingest/votes";
import { writeVotesToSupabase } from "../lib/ingest/supabase-writer";
import type { RosterSnapshot, Vote, VotesSnapshot } from "../lib/types";

const OUT = path.join(process.cwd(), "data", "votes.json");
const ROSTER = path.join(process.cwd(), "data", "roster.json");
const check = process.argv.includes("--check");
const force = process.argv.includes("--force");
const fetchedAt = new Date().toISOString();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with one retry; returns null on 404. Spaced out to stay polite to the chambers' servers. */
async function get(url: string): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    await sleep(150);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "uniparty-ingest (+https://github.com/brucewmilleriii/uniparty)" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(2000);
    }
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const errors: string[] = [];
const fresh: Vote[] = [];

function accept(parsed: ParsedVote, body: string) {
  const problems = validateVote(parsed);
  if (problems.length) errors.push(...problems);
  else fresh.push(toVote(parsed, sha(body), fetchedAt));
}

/** House rolls are numbered per calendar year with no gaps, so find the last one by doubling then bisecting. */
async function latestHouseRoll(year: number, knownAtLeast: number): Promise<number> {
  const cache = new Map<number, boolean>();
  const exists = async (n: number) => {
    if (!cache.has(n)) cache.set(n, isHouseVoteXml((await get(houseVoteUrl(year, n))) ?? ""));
    return cache.get(n)!;
  };
  let lo = knownAtLeast;
  if (lo === 0) {
    if (!(await exists(1))) return 0;
    lo = 1;
  }
  let hi = lo + 1;
  while (await exists(hi)) {
    lo = hi;
    hi = lo + Math.max(1, lo);
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function ingestHouse(have: Set<string>, previous: Vote[]) {
  const year = new Date().getUTCFullYear();
  let wanted = VOTE_WINDOW;
  for (const y of [year, year - 1]) {
    const known = Math.max(0, ...previous.filter((v) => v.id.startsWith(`house-${y}-`)).map((v) => v.rollNumber));
    const latest = await latestHouseRoll(y, known);
    console.log(`House ${y}: latest roll call is ${latest || "none yet"}`);
    for (let roll = latest; roll >= 1 && wanted > 0; roll--, wanted--) {
      if (have.has(`house-${y}-${roll}`)) continue;
      const url = houseVoteUrl(y, roll);
      const body = await get(url);
      if (!body || !isHouseVoteXml(body)) {
        errors.push(`house-${y}-${roll}: ${url} is missing`);
        continue;
      }
      accept(parseHouseVote(body, y, url), body);
    }
    if (wanted <= 0) break;
  }
}

async function ingestSenate(have: Set<string>, lisToBioguide: Map<string, string>) {
  const year = new Date().getUTCFullYear();
  let wanted = VOTE_WINDOW;
  for (const y of [year, year - 1]) {
    const { congress, session } = congressForYear(y);
    const menu = await get(senateMenuUrl(congress, session));
    // A new Congress or session has no menu until its first vote.
    const rolls = menu ? parseSenateMenu(menu) : [];
    console.log(`Senate ${congress}-${session}: ${rolls.length} roll calls listed`);
    for (const roll of rolls.slice(0, wanted)) {
      wanted--;
      if (have.has(`senate-${congress}-${session}-${roll}`)) continue;
      const url = senateVoteUrl(congress, session, roll);
      const body = await get(url);
      if (!body) {
        errors.push(`senate-${congress}-${session}-${roll}: ${url} is missing`);
        continue;
      }
      accept(parseSenateVote(body, url, lisToBioguide), body);
    }
    if (wanted <= 0) break;
  }
}

async function main() {
  const roster = JSON.parse(await readFile(ROSTER, "utf8")) as RosterSnapshot;
  const lisToBioguide = new Map(roster.members.filter((m) => m.lisId).map((m) => [m.lisId!, m.bioguideId]));

  let prev: VotesSnapshot | null = null;
  try {
    prev = JSON.parse(await readFile(OUT, "utf8")) as VotesSnapshot;
  } catch {
    // No previous snapshot yet.
  }
  const previous = force ? [] : (prev?.votes ?? []);
  const have = new Set(previous.map((v) => v.id));

  await ingestHouse(have, previous);
  await ingestSenate(have, lisToBioguide);

  if (errors.length) {
    console.error(`Votes failed validation (${errors.length} problems); keeping the previous snapshot.`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }

  const votes = mergeVotes(previous, fresh);
  const snapshot: VotesSnapshot = {
    provenance: { fetchedAt, window: VOTE_WINDOW, house: VOTE_SOURCES.house, senate: VOTE_SOURCES.senate },
    votes,
  };
  const problems = validateVotesSnapshot(snapshot);
  if (problems.length) {
    console.error(`Votes snapshot failed validation; keeping the previous snapshot.`);
    for (const e of problems) console.error(`  - ${e}`);
    process.exit(1);
  }

  const counts = `${votes.filter((v) => v.chamber === "house").length} House, ${votes.filter((v) => v.chamber === "senate").length} Senate`;
  if (check) {
    console.log(`Check passed: ${fresh.length} roll calls fetched and validated (${counts} in window). Nothing written.`);
    return;
  }

  // Skip the write when nothing changed, so the scheduled job only commits (and redeploys) on new votes.
  const unchanged = prev && prev.votes.map((v) => v.sha256).join() === votes.map((v) => v.sha256).join();
  if (unchanged && !force) {
    console.log(`No new roll calls since ${prev!.provenance.fetchedAt}; snapshot left as is.`);
  } else {
    await writeFile(OUT, JSON.stringify(snapshot, null, 1) + "\n");
    console.log(`Wrote ${votes.length} roll calls (${counts}; ${fresh.length} new) to ${path.relative(process.cwd(), OUT)}`);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const n = await writeVotesToSupabase(url, key, votes, fetchedAt);
    console.log(`Upserted ${n} roll calls into Supabase.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
