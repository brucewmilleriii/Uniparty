import { positionBucket } from "@/lib/ingest/votes";
import type { PartyCode, VotePosition } from "@/lib/types";

export type Side = "yea" | "nay";

/** "yea" or "nay" for a recorded position, or null for present, not voting and anything else. */
export function sideOf(position: VotePosition): Side | null {
  const b = positionBucket(position);
  return b === "yea" || b === "nay" ? b : null;
}

/**
 * How most members of a party voted on one roll call, counting only Yea and Nay.
 * Null for independents (they caucus differently), when nobody in the party voted, or on a tie.
 */
export function partyMajority(
  positions: Record<string, VotePosition>,
  partyOf: (bioguideId: string) => PartyCode | undefined,
  party: PartyCode,
): Side | null {
  if (party === "I") return null;
  let yea = 0;
  let nay = 0;
  for (const [id, p] of Object.entries(positions)) {
    if (partyOf(id) !== party) continue;
    const s = sideOf(p);
    if (s === "yea") yea++;
    else if (s === "nay") nay++;
  }
  if (yea === nay) return null;
  return yea > nay ? "yea" : "nay";
}

export interface SummaryRow {
  position: VotePosition;
  /** How most of the member's party voted; null when unknown. */
  partyMajority: Side | null;
}

export interface VoteSummary<R extends SummaryRow> {
  total: number;
  /** Yea or Nay votes. */
  cast: number;
  missed: number;
  present: number;
  /** Roll calls where the member voted Yea or Nay and their party's majority is known. */
  comparable: number;
  withParty: number;
  /** Votes against the party majority, in the order given (newest first from the data layer). */
  breaks: R[];
}

export function summarizeVotes<R extends SummaryRow>(rows: R[]): VoteSummary<R> {
  const s: VoteSummary<R> = { total: rows.length, cast: 0, missed: 0, present: 0, comparable: 0, withParty: 0, breaks: [] };
  for (const r of rows) {
    const b = positionBucket(r.position);
    if (b === "notVoting") s.missed++;
    else if (b === "present") s.present++;
    const side = sideOf(r.position);
    if (!side) continue;
    s.cast++;
    if (!r.partyMajority) continue;
    s.comparable++;
    if (side === r.partyMajority) s.withParty++;
    else s.breaks.push(r);
  }
  return s;
}

/** Election Day for federal offices: the Tuesday after the first Monday in November of an even year, on or after `from`. */
export function nextElectionDay(from: Date): Date {
  for (let year = from.getUTCFullYear(); ; year++) {
    if (year % 2) continue;
    const nov1 = new Date(Date.UTC(year, 10, 1));
    const firstMonday = 1 + ((8 - nov1.getUTCDay()) % 7);
    const day = new Date(Date.UTC(year, 10, firstMonday + 1));
    const today = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    if (day.getTime() >= today) return day;
  }
}
