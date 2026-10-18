import { describe, expect, it } from "vitest";
import roster from "@/data/roster.json";
import votesSnapshot from "@/data/votes.json";
import { nextElectionDay, partyMajority, sideOf, summarizeVotes } from "@/lib/summary";
import type { PartyCode, RosterSnapshot, VotesSnapshot } from "@/lib/types";

const partyOf = (map: Record<string, PartyCode>) => (id: string) => map[id];

describe("sideOf", () => {
  it("maps both chambers' spellings and ignores the rest", () => {
    expect(sideOf("Aye")).toBe("yea");
    expect(sideOf("Yea")).toBe("yea");
    expect(sideOf("No")).toBe("nay");
    expect(sideOf("Nay")).toBe("nay");
    expect(sideOf("Not Voting")).toBeNull();
    expect(sideOf("Present")).toBeNull();
  });
});

describe("partyMajority", () => {
  const parties = partyOf({ A: "D", B: "D", C: "D", X: "R", Y: "R", I1: "I" });

  it("counts only the member's party, and only Yea and Nay", () => {
    expect(partyMajority({ A: "Yea", B: "Nay", C: "Aye", X: "No", Y: "No" }, parties, "D")).toBe("yea");
    expect(partyMajority({ A: "Yea", B: "Nay", C: "Aye", X: "No", Y: "No" }, parties, "R")).toBe("nay");
    expect(partyMajority({ A: "Not Voting", B: "Present", C: "No" }, parties, "D")).toBe("nay");
  });

  it("is null on a tie, with no party votes, or for independents", () => {
    expect(partyMajority({ A: "Yea", B: "Nay" }, parties, "D")).toBeNull();
    expect(partyMajority({ X: "Yea" }, parties, "D")).toBeNull();
    expect(partyMajority({ I1: "Yea", A: "Yea" }, parties, "I")).toBeNull();
  });
});

describe("summarizeVotes", () => {
  it("tallies attendance, party agreement and breaks", () => {
    const rows = [
      { id: 1, position: "Yea", partyMajority: "nay" as const },
      { id: 2, position: "No", partyMajority: "nay" as const },
      { id: 3, position: "Not Voting", partyMajority: "yea" as const },
      { id: 4, position: "Present", partyMajority: "yea" as const },
      { id: 5, position: "Aye", partyMajority: null },
    ];
    const s = summarizeVotes(rows);
    expect(s).toMatchObject({ total: 5, cast: 3, missed: 1, present: 1, comparable: 2, withParty: 1 });
    expect(s.breaks.map((r) => r.id)).toEqual([1]);
  });

  it("matches a hand check against the committed snapshot", () => {
    // Pelosi's last 50 House roll calls: 46 Yea/Nay, 3 missed, 1 present; one vote against most Democrats (roll 308).
    const members = (roster as RosterSnapshot).members;
    const map = Object.fromEntries(members.map((m) => [m.bioguideId, m.party])) as Record<string, PartyCode>;
    const votes = (votesSnapshot as unknown as VotesSnapshot).votes.filter((v) => v.chamber === "house" && v.positions.P000197);
    const rows = votes.map((v) => ({ roll: v.rollNumber, position: v.positions.P000197, partyMajority: partyMajority(v.positions, partyOf(map), "D") }));
    const s = summarizeVotes(rows);
    expect(s.total).toBe(rows.length);
    expect(s.cast + s.missed + s.present).toBe(s.total);
    expect(s.withParty + s.breaks.length).toBe(s.comparable);
  });
});

describe("nextElectionDay", () => {
  it("finds the Tuesday after the first Monday in November of an even year", () => {
    expect(nextElectionDay(new Date("2026-10-17T12:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(nextElectionDay(new Date("2026-11-03T23:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(nextElectionDay(new Date("2026-11-04T00:00:00Z")).toISOString().slice(0, 10)).toBe("2028-11-07");
    expect(nextElectionDay(new Date("2027-03-01T00:00:00Z")).toISOString().slice(0, 10)).toBe("2028-11-07");
    expect(nextElectionDay(new Date("2030-01-01T00:00:00Z")).toISOString().slice(0, 10)).toBe("2030-11-05");
  });
});
