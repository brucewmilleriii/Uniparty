import type { Chamber, CommitteeSeat, Member, PartyCode } from "@/lib/types";

/*
 * Transform and validate the unitedstates/congress-legislators "current" files.
 * Pure functions only: fetching and writing live in scripts/ingest-roster.ts.
 */

export const ROSTER_SOURCE = {
  source: "unitedstates/congress-legislators",
  sourceHome: "https://github.com/unitedstates/congress-legislators",
  base: "https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages",
  files: {
    legislators: "legislators-current.json",
    committees: "committees-current.json",
    membership: "committee-membership-current.json",
  },
} as const;

interface RawTerm {
  type: "sen" | "rep";
  start: string;
  end: string;
  state: string;
  district?: number;
  party: string;
  url?: string;
  phone?: string;
  address?: string;
}

export interface RawLegislator {
  id: { bioguide: string; fec?: string[] };
  name: { first: string; last: string; official_full?: string };
  bio?: { birthday?: string };
  terms: RawTerm[];
}

export interface RawCommittee {
  thomas_id: string;
  name: string;
  type: string;
  subcommittees?: { thomas_id: string; name: string }[];
}

export type RawMembership = Record<string, { bioguide: string; title?: string; rank?: number }[]>;

const PARTY_CODES: Record<string, PartyCode> = {
  Democrat: "D",
  Republican: "R",
  Independent: "I",
};

function shortCommitteeName(name: string): string {
  return name.replace(/^(House|Senate) Committee on /, "").replace(/^Committee on /, "");
}

export function transformRoster(
  legislators: RawLegislator[],
  committees: RawCommittee[],
  membership: RawMembership,
): Member[] {
  // Full committees only; subcommittee ids (e.g. HSAG15) are skipped for now.
  const names = new Map(committees.map((c) => [c.thomas_id, shortCommitteeName(c.name)]));
  const seats = new Map<string, CommitteeSeat[]>();
  for (const [committeeId, members] of Object.entries(membership)) {
    const name = names.get(committeeId);
    if (!name) continue;
    for (const m of members) {
      const list = seats.get(m.bioguide) ?? [];
      list.push({ committeeId, name, title: m.title ?? null });
      seats.set(m.bioguide, list);
    }
  }

  return legislators.map((l) => {
    const term = l.terms[l.terms.length - 1];
    const chamber: Chamber = term.type === "sen" ? "senate" : "house";
    const firstInChamber = l.terms
      .filter((t) => t.type === term.type)
      .reduce((min, t) => (t.start < min ? t.start : min), term.start);
    return {
      bioguideId: l.id.bioguide,
      name: l.name.official_full ?? `${l.name.first} ${l.name.last}`,
      lastName: l.name.last,
      chamber,
      state: term.state,
      district: chamber === "house" ? (term.district ?? 0) : null,
      party: PARTY_CODES[term.party] ?? "I",
      partyName: term.party,
      servingSince: firstInChamber.slice(0, 4),
      termStart: term.start,
      termEnd: term.end,
      phone: term.phone ?? null,
      website: term.url ?? null,
      office: term.address ?? null,
      birthday: l.bio?.birthday ?? null,
      fecIds: l.id.fec ?? [],
      committees: seats.get(l.id.bioguide) ?? [],
    };
  });
}

// Five delegates plus the Resident Commissioner of Puerto Rico.
const NON_VOTING = new Set(["AS", "DC", "GU", "MP", "PR", "VI"]);

/**
 * Sanity checks that catch a broken or partial upstream file before it replaces
 * good data. Returns a list of problems; an empty list means the roster is usable.
 */
export function validateRoster(members: Member[], today = new Date()): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const m of members) {
    if (ids.has(m.bioguideId)) errors.push(`Duplicate bioguide id ${m.bioguideId}`);
    ids.add(m.bioguideId);
    if (!/^[A-Z]\d{6}$/.test(m.bioguideId)) errors.push(`Malformed bioguide id "${m.bioguideId}"`);
    if (!m.name || !m.state) errors.push(`${m.bioguideId} is missing a name or state`);
    if (!PARTY_CODES[m.partyName]) errors.push(`${m.bioguideId} has unrecognised party "${m.partyName}"`);
    if (new Date(m.termEnd) < today) errors.push(`${m.bioguideId} has a term that ended ${m.termEnd}`);
  }

  const senators = members.filter((m) => m.chamber === "senate");
  if (senators.length > 100) errors.push(`Senate has ${senators.length} members (max 100)`);
  if (senators.length < 95) errors.push(`Senate has only ${senators.length} members; source looks incomplete`);
  const perState = new Map<string, number>();
  for (const s of senators) perState.set(s.state, (perState.get(s.state) ?? 0) + 1);
  for (const [state, n] of perState) if (n > 2) errors.push(`${state} has ${n} senators`);

  const house = members.filter((m) => m.chamber === "house");
  const voting = house.filter((m) => !NON_VOTING.has(m.state));
  if (voting.length > 435) errors.push(`House has ${voting.length} voting members (max 435)`);
  if (voting.length < 420) errors.push(`House has only ${voting.length} voting members; source looks incomplete`);
  const seatsTaken = new Set<string>();
  for (const r of house) {
    const seat = `${r.state}-${r.district}`;
    if (seatsTaken.has(seat)) errors.push(`Two members hold ${seat}`);
    seatsTaken.add(seat);
  }

  return errors;
}
