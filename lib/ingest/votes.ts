import { XMLParser } from "fast-xml-parser";
import type { Chamber, Vote, VoteTotals, VotesSnapshot } from "@/lib/types";

/*
 * Parse and validate roll-call votes from the House Clerk and the Senate.
 * Pure functions only: fetching and writing live in scripts/ingest-votes.ts.
 */

/** How many of the most recent roll calls to keep per chamber. */
export const VOTE_WINDOW = 50;

export const VOTE_SOURCES = {
  house: { source: "Office of the Clerk, U.S. House", sourceHome: "https://clerk.house.gov/Votes" },
  senate: { source: "U.S. Senate", sourceHome: "https://www.senate.gov/legislative/votes_new.htm" },
} as const;

export function congressForYear(year: number): { congress: number; session: number } {
  return { congress: Math.floor((year - 1789) / 2) + 1, session: year % 2 === 1 ? 1 : 2 };
}

export const houseVoteUrl = (year: number, roll: number) => `https://clerk.house.gov/evs/${year}/roll${String(roll).padStart(3, "0")}.xml`;
export const houseVotePage = (year: number, roll: number) => `https://clerk.house.gov/Votes/${year}${roll}`;
export const senateMenuUrl = (congress: number, session: number) =>
  `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`;
const senateBase = (congress: number, session: number, roll: number) =>
  `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${String(roll).padStart(5, "0")}`;
export const senateVoteUrl = (congress: number, session: number, roll: number) => `${senateBase(congress, session, roll)}.xml`;
export const senateVotePage = (congress: number, session: number, roll: number) => `${senateBase(congress, session, roll)}.htm`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) =>
    ["rollcall-vote.vote-data.recorded-vote", "roll_call_vote.members.member", "vote_summary.votes.vote"].includes(String(jpath)),
});

type Node = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && "#text" in v ? String((v as Node)["#text"]) : "").replace(/\s+/g, " ").trim();
const int = (v: unknown): number => {
  const n = parseInt(text(v), 10);
  return Number.isFinite(n) ? n : 0;
};

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

// Congress.gov URL slugs and display labels by normalised measure type.
const MEASURES: Record<string, { label: string; slug: string }> = {
  HR: { label: "H.R.", slug: "house-bill" },
  S: { label: "S.", slug: "senate-bill" },
  HRES: { label: "H.Res.", slug: "house-resolution" },
  SRES: { label: "S.Res.", slug: "senate-resolution" },
  HJRES: { label: "H.J.Res.", slug: "house-joint-resolution" },
  SJRES: { label: "S.J.Res.", slug: "senate-joint-resolution" },
  HCONRES: { label: "H.Con.Res.", slug: "house-concurrent-resolution" },
  SCONRES: { label: "S.Con.Res.", slug: "senate-concurrent-resolution" },
};

const ordinalSuffix = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");

/** "H R 4541" (House) or type "H.R." + number "4541" (Senate) → label and Congress.gov link. */
export function measureRef(raw: string, congress: number): { measure: string | null; measureUrl: string | null } {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return { measure: null, measureUrl: null };
  const nom = s.match(/^PN\s?(\d+)(?:-(\d+))?$/i);
  if (nom) return { measure: s.replace(/\s/g, ""), measureUrl: `https://www.congress.gov/nomination/${congress}${ordinalSuffix(congress)}-congress/${nom[1]}` };
  const m = s.match(/^([A-Za-z.\s]+?)\s?(\d+)$/);
  if (!m) return { measure: null, measureUrl: null }; // QUORUM, ADJOURN, MOTION and the like
  const def = MEASURES[m[1].replace(/[.\s]/g, "").toUpperCase()];
  if (!def) return { measure: s, measureUrl: null };
  return {
    measure: `${def.label} ${m[2]}`,
    measureUrl: `https://www.congress.gov/bill/${congress}${ordinalSuffix(congress)}-congress/${def.slug}/${m[2]}`,
  };
}

export interface ParsedVote extends Omit<Vote, "sha256" | "fetchedAt"> {
  /** Every position in the source file, including members we couldn't match to a bioguide id. */
  recorded: number;
  /** Source member ids (Senate LIS ids) that don't match anyone on the roster. */
  unmatched: string[];
  duplicates: string[];
}

/** Parse one House Clerk roll-call file (clerk.house.gov/evs/YYYY/rollNNN.xml). */
export function parseHouseVote(xml: string, year: number, sourceUrl: string): ParsedVote {
  const doc = parser.parse(xml) as Node;
  const root = doc["rollcall-vote"] as Node | undefined;
  if (!root) throw new Error(`${sourceUrl} is not a House roll-call file`);
  const meta = root["vote-metadata"] as Node;
  const congress = int(meta.congress);
  const session = int(meta.session); // "2nd" → 2
  const rollNumber = int(meta["rollcall-num"]);

  const [d, mon, y] = text(meta["action-date"]).split("-");
  const date = `${y}-${MONTHS[mon?.toLowerCase()] ?? "??"}-${d?.padStart(2, "0")}`;
  const actionTime = meta["action-time"] as Node | string | undefined;
  const etz = typeof actionTime === "object" ? text(actionTime["@time-etz"]) : "";

  const byVote = ((meta["vote-totals"] as Node | undefined)?.["totals-by-vote"] ?? null) as Node | null;
  const totals: VoteTotals | null = byVote
    ? { yea: int(byVote["yea-total"]), nay: int(byVote["nay-total"]), present: int(byVote["present-total"]), notVoting: int(byVote["not-voting-total"]) }
    : null;

  const positions: Record<string, string> = {};
  const duplicates: string[] = [];
  const rows = ((root["vote-data"] as Node | undefined)?.["recorded-vote"] ?? []) as Node[];
  for (const r of rows) {
    const id = text((r.legislator as Node)["@name-id"]);
    if (positions[id] !== undefined) duplicates.push(id);
    positions[id] = text(r.vote);
  }

  return {
    id: `house-${year}-${rollNumber}`,
    chamber: "house",
    congress,
    session,
    rollNumber,
    date,
    time: /^\d{1,2}:\d{2}$/.test(etz) ? etz.padStart(5, "0") : null,
    question: text(meta["vote-question"]),
    description: text(meta["vote-desc"]),
    ...measureRef(text(meta["legis-num"]), congress),
    result: text(meta["vote-result"]),
    totals,
    pageUrl: houseVotePage(year, rollNumber),
    sourceUrl,
    positions,
    recorded: rows.length,
    unmatched: [],
    duplicates,
  };
}

/** "September 30, 2026,  09:29 PM" → { date: "2026-09-30", time: "21:29" } */
function senateDateTime(s: string): { date: string; time: string | null } {
  const m = s.match(/^([A-Za-z]+) (\d{1,2}), (\d{4}),?\s+(\d{1,2}):(\d{2}) ?([AP]M)?/);
  if (!m) return { date: "", time: null };
  let h = Number(m[4]);
  if (m[6] === "PM" && h < 12) h += 12;
  if (m[6] === "AM" && h === 12) h = 0;
  return { date: `${m[3]}-${MONTHS[m[1].slice(0, 3).toLowerCase()] ?? "??"}-${m[2].padStart(2, "0")}`, time: `${String(h).padStart(2, "0")}:${m[5]}` };
}

/**
 * Parse one Senate roll-call file. Senators are identified by LIS id there, so
 * `lisToBioguide` (built from the roster) maps them onto profiles.
 */
export function parseSenateVote(xml: string, sourceUrl: string, lisToBioguide: Map<string, string>): ParsedVote {
  const doc = parser.parse(xml) as Node;
  const root = doc.roll_call_vote as Node | undefined;
  if (!root) throw new Error(`${sourceUrl} is not a Senate roll-call file`);
  const congress = int(root.congress);
  const session = int(root.session);
  const rollNumber = int(root.vote_number);
  const { date, time } = senateDateTime(text(root.vote_date));
  const doc_ = (root.document ?? {}) as Node;
  const count = (root.count ?? {}) as Node;

  const positions: Record<string, string> = {};
  const unmatched: string[] = [];
  const duplicates: string[] = [];
  const rows = ((root.members as Node | undefined)?.member ?? []) as Node[];
  for (const r of rows) {
    const lis = text(r.lis_member_id);
    const id = lisToBioguide.get(lis);
    if (!id) {
      unmatched.push(lis);
      continue;
    }
    if (positions[id] !== undefined) duplicates.push(id);
    positions[id] = text(r.vote_cast);
  }

  const type = text(doc_.document_type);
  const number = text(doc_.document_number);
  const amendment = text((root.amendment as Node | undefined)?.amendment_number);
  return {
    id: `senate-${congress}-${session}-${rollNumber}`,
    chamber: "senate",
    congress,
    session,
    rollNumber,
    date,
    time,
    question: text(root.question) || text(root.vote_question_text),
    description: text(root.vote_title) || text(root.vote_document_text) || (amendment ? `Amendment ${amendment}` : ""),
    ...measureRef(type && number ? (type === "PN" ? `PN${number}` : `${type} ${number}`) : "", congress),
    result: text(root.vote_result) || text(root.vote_result_text),
    // The Senate leaves present/absent empty when they are zero.
    totals: { yea: int(count.yeas), nay: int(count.nays), present: int(count.present), notVoting: int(count.absent) },
    pageUrl: senateVotePage(congress, session, rollNumber),
    sourceUrl,
    positions,
    recorded: rows.length,
    unmatched,
    duplicates,
  };
}

/** Roll numbers listed in a Senate vote menu (vote_menu_CONGRESS_SESSION.xml), newest first. */
export function parseSenateMenu(xml: string): number[] {
  const doc = parser.parse(xml) as Node;
  const votes = ((doc.vote_summary as Node | undefined)?.votes as Node | undefined)?.vote as Node[] | undefined;
  if (!votes) throw new Error("Not a Senate vote menu");
  return votes.map((v) => int(v.vote_number)).filter((n) => n > 0).sort((a, b) => b - a);
}

/** True when a House Clerk response is a real roll call; missing rolls come back as HTTP 200 with an error document. */
export const isHouseVoteXml = (body: string) => body.includes("<rollcall-vote");

type Bucket = keyof VoteTotals | "other";
const BUCKETS: Record<string, Bucket> = {
  yea: "yea", aye: "yea", guilty: "yea",
  nay: "nay", no: "nay", "not guilty": "nay",
  present: "present", "present, giving live pair": "present",
  "not voting": "notVoting",
};
/** Which official total a recorded position counts toward; "other" for votes like the election of the Speaker. */
export const positionBucket = (p: string): Bucket => BUCKETS[p.toLowerCase()] ?? "other";

const SEATS: Record<Chamber, { min: number; max: number; maxUnmatched: number }> = {
  house: { min: 380, max: 441, maxUnmatched: 0 },
  senate: { min: 90, max: 100, maxUnmatched: 5 },
};

/**
 * Checks that catch a truncated or misread vote before it is published.
 * Returns a list of problems; an empty list means the vote is usable.
 */
export function validateVote(v: ParsedVote, today = new Date()): string[] {
  const errors: string[] = [];
  const at = v.id;
  if (v.congress < 100 || v.congress > 200) errors.push(`${at}: implausible Congress ${v.congress}`);
  if (v.session < 1 || v.session > 3) errors.push(`${at}: implausible session ${v.session}`);
  if (!(v.rollNumber > 0)) errors.push(`${at}: missing roll number`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || Number.isNaN(Date.parse(v.date))) errors.push(`${at}: unreadable date "${v.date}"`);
  else if (Date.parse(v.date) > today.getTime() + 86_400_000) errors.push(`${at}: dated in the future (${v.date})`);
  if (!v.question) errors.push(`${at}: missing question`);
  if (!v.result) errors.push(`${at}: missing result`);
  if (v.duplicates.length) errors.push(`${at}: members recorded twice: ${v.duplicates.join(", ")}`);

  const seats = SEATS[v.chamber];
  if (v.recorded < seats.min || v.recorded > seats.max)
    errors.push(`${at}: ${v.recorded} members recorded, expected ${seats.min}–${seats.max}; file looks incomplete`);
  if (v.unmatched.length > seats.maxUnmatched)
    errors.push(`${at}: ${v.unmatched.length} members not on the roster (${v.unmatched.slice(0, 5).join(", ")})`);

  // Tally the recorded positions and compare with the official totals.
  const tally = { yea: 0, nay: 0, present: 0, notVoting: 0, other: 0 };
  let blank = 0;
  for (const p of Object.values(v.positions)) {
    if (!p) blank++;
    else tally[positionBucket(p)]++;
  }
  if (blank) errors.push(`${at}: ${blank} members have no recorded position`);
  // Positions outside Yea/Nay/Present/Not Voting only make sense where there are no
  // yea/nay totals, as in the election of a Speaker.
  if (tally.other && v.totals) errors.push(`${at}: ${tally.other} positions don't fit the official totals`);
  if (tally.other === 0) {
    if (!v.totals) errors.push(`${at}: no official totals to check against`);
    else if (v.unmatched.length === 0) {
      for (const k of ["yea", "nay", "present", "notVoting"] as const)
        if (tally[k] !== v.totals[k]) errors.push(`${at}: ${k} count ${tally[k]} does not match the official total ${v.totals[k]}`);
    } else {
      // Unmatched senators can't be tallied by position, but the grand total must still add up.
      const official = v.totals.yea + v.totals.nay + v.totals.present + v.totals.notVoting;
      if (official !== v.recorded) errors.push(`${at}: ${v.recorded} members recorded but official totals add to ${official}`);
    }
  }
  return errors;
}

/** Drop parse-only fields and stamp provenance. */
export function toVote(v: ParsedVote, sha256: string, fetchedAt: string): Vote {
  const { recorded: _r, unmatched: _u, duplicates: _d, ...vote } = v;
  return { ...vote, sha256, fetchedAt };
}

/** Newest first: by date, then time, then roll number. */
export function compareVotes(a: Pick<Vote, "date" | "time" | "rollNumber">, b: Pick<Vote, "date" | "time" | "rollNumber">): number {
  return b.date.localeCompare(a.date) || (b.time ?? "").localeCompare(a.time ?? "") || b.rollNumber - a.rollNumber;
}

/** Combine previously published votes with new ones and keep the most recent `window` per chamber. */
export function mergeVotes(previous: Vote[], fresh: Vote[], window = VOTE_WINDOW): Vote[] {
  const byId = new Map(previous.map((v) => [v.id, v]));
  for (const v of fresh) byId.set(v.id, v);
  const all = [...byId.values()].sort(compareVotes);
  return [...all.filter((v) => v.chamber === "house").slice(0, window), ...all.filter((v) => v.chamber === "senate").slice(0, window)].sort(compareVotes);
}

/** Whole-snapshot checks run after merging. */
export function validateVotesSnapshot(snap: VotesSnapshot): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const v of snap.votes) {
    if (ids.has(v.id)) errors.push(`Duplicate vote ${v.id}`);
    ids.add(v.id);
    if (!/^[0-9a-f]{64}$/.test(v.sha256)) errors.push(`${v.id} has no source hash`);
    if (!v.sourceUrl.startsWith("https://")) errors.push(`${v.id} has no source URL`);
  }
  for (const chamber of ["house", "senate"] as const)
    if (!snap.votes.some((v) => v.chamber === chamber)) errors.push(`No ${chamber} votes; source looks unreachable or empty`);
  return errors;
}
