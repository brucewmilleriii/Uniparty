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

/** A bill or resolution, as listed by Congress.gov. */
export interface Bill {
  /** "119-s-5285" */
  id: string;
  congress: number;
  /** Congress.gov type code: HR, S, HRES, SRES, HJRES, SJRES, HCONRES, SCONRES. */
  type: string;
  number: number;
  /** "S. 5285" */
  label: string;
  title: string;
  /** CRS policy area; null until CRS assigns one. */
  policyArea: string | null;
  latestAction: { date: string; text: string } | null;
  /** The bill's page on Congress.gov. */
  pageUrl: string;
  /** The Congress.gov API record it was read from. */
  sourceUrl: string;
  fetchedAt: string;
}

/** A member's link to a bill. `date` is when the bill was introduced (sponsor) or when the member signed on (cosponsor). */
export interface BillLink {
  billId: string;
  date: string;
}

export interface MemberBills {
  /** Bills and resolutions sponsored in the current Congress (amendments are not counted). */
  sponsoredCount: number;
  cosponsoredCount: number;
  /** Most recent first, up to the snapshot's window. */
  sponsored: BillLink[];
  cosponsored: BillLink[];
  /** Every Congress.gov API page read for this member, with its SHA-256. */
  sources: { url: string; sha256: string }[];
  fetchedAt: string;
}

export interface BillsSnapshot {
  provenance: {
    source: string;
    sourceHome: string;
    /** Null until the first successful pull. */
    fetchedAt: string | null;
    /** The Congress the counts cover. */
    congress: number;
    /** How many recent bills are kept per member for each of sponsored and cosponsored. */
    window: number;
  };
  /** Keyed by bill id. */
  bills: Record<string, Bill>;
  /** Keyed by bioguide id. */
  members: Record<string, MemberBills>;
}

/**
 * One campaign's money for a two-year cycle, as the FEC totals the reports its
 * authorized committees filed. Receipts are the sum of the receipt lines below.
 */
export interface CampaignTotals {
  /** FEC candidate id: H… for a House campaign, S… for Senate. */
  candidateId: string;
  office: "H" | "S";
  /** The election the campaign is raising for. */
  electionYear: number | null;
  /** Two-year cycle, named for its even year (2026 = 2025–26). */
  cycle: number;
  coverageStart: string;
  coverageEnd: string;
  /** The latest report in the totals, e.g. "OCTOBER QUARTERLY 2026". */
  lastReport: string | null;
  receipts: number;
  disbursements: number;
  /** At the end of the latest report. */
  cashOnHand: number;
  debts: number;
  /** Individuals who gave more than $200 in total, whom the committee must name. */
  individualItemized: number;
  /** Individuals who gave $200 or less. */
  individualUnitemized: number;
  partyCommittees: number;
  /** PACs and other non-party committees. */
  otherCommittees: number;
  candidateContributions: number;
  candidateLoans: number;
  otherLoans: number;
  transfersIn: number;
  /** Other receipts, offsets to operating expenditures and any public funds. */
  otherReceipts: number;
  /** This campaign on fec.gov. */
  pageUrl: string;
  /** The FEC API record it was read from (no key). */
  sourceUrl: string;
  sha256: string;
  fetchedAt: string;
}

export interface MemberFinance {
  /** The House and Senate candidate ids the pull asked the FEC about for this member. */
  candidateIds: string[];
  /** The campaign for the member's current seat first. Empty when no reports were filed in the cycle. */
  campaigns: CampaignTotals[];
  fetchedAt: string;
}

export interface FinanceSnapshot {
  provenance: {
    source: string;
    sourceHome: string;
    /** Null until the first successful pull. */
    fetchedAt: string | null;
    cycle: number;
  };
  /** The candidates/totals pages used to find and cross-check each campaign. */
  sources: { url: string; sha256: string }[];
  /** Keyed by bioguide id; members with no FEC candidate id are left out. */
  members: Record<string, MemberFinance>;
}
