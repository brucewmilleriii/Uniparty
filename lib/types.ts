export type Chamber = "senate" | "house";
export type PartyCode = "D" | "R" | "I";

export interface CommitteeSeat {
  committeeId: string;
  name: string;
  /** Leadership title such as "Chairman" or "Ranking Member", when the source gives one. */
  title: string | null;
}

export interface Member {
  bioguideId: string;
  name: string;
  lastName: string;
  chamber: Chamber;
  state: string;
  /** House district; 0 for at-large seats, null for senators. */
  district: number | null;
  party: PartyCode;
  partyName: string;
  /** Year the member first took office in their current chamber. */
  servingSince: string;
  termStart: string;
  termEnd: string;
  phone: string | null;
  website: string | null;
  office: string | null;
  birthday: string | null;
  fecIds: string[];
  /** Senate LIS id (e.g. "S275"), which Senate.gov vote files use instead of the bioguide id. */
  lisId: string | null;
  committees: CommitteeSeat[];
}

export interface SourceFile {
  url: string;
  sha256: string;
  bytes: number;
  lastModified: string | null;
  etag: string | null;
}

/** Where a dataset came from and when, so every page can say how current it is. */
export interface Provenance {
  source: string;
  sourceHome: string;
  fetchedAt: string;
  files: SourceFile[];
}

export interface RosterSnapshot {
  provenance: Provenance;
  counts: { senate: number; house: number; total: number };
  members: Member[];
}

/** A member's recorded position, exactly as the chamber wrote it ("Yea", "Aye", "No", "Not Voting", a candidate's name...). */
export type VotePosition = string;

export interface VoteTotals {
  yea: number;
  nay: number;
  present: number;
  notVoting: number;
}

/** One roll-call vote, as recorded by the House Clerk or the Senate. */
export interface Vote {
  /** "house-2026-250" (House rolls are numbered per calendar year) or "senate-119-2-256" (per session). */
  id: string;
  chamber: Chamber;
  congress: number;
  session: number;
  rollNumber: number;
  /** ISO date of the vote, Washington time. */
  date: string;
  /** 24-hour "HH:MM", Washington time, when the source gives it. */
  time: string | null;
  question: string;
  /** Short description of the measure or nomination. */
  description: string;
  /** "H.R. 4541", "S.Res. 852", "PN1129"; null for procedural votes like quorum calls. */
  measure: string | null;
  measureUrl: string | null;
  result: string;
  /** Official totals from the source; null when the source gives none (e.g. election of the Speaker). */
  totals: VoteTotals | null;
  /** The human-readable page for this vote on the chamber's own site. */
  pageUrl: string;
  sourceUrl: string;
  sha256: string;
  fetchedAt: string;
  /** Position by bioguide id. */
  positions: Record<string, VotePosition>;
}

export interface VotesSourceRef {
  source: string;
  sourceHome: string;
}

export interface VotesSnapshot {
  provenance: {
    /** Null until the first successful pull. */
    fetchedAt: string | null;
    /** How many of the most recent roll calls are kept per chamber. */
    window: number;
    house: VotesSourceRef;
    senate: VotesSourceRef;
  };
  votes: Vote[];
}
