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
