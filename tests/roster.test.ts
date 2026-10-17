import { describe, expect, it } from "vitest";
import fixture from "./fixtures/roster-sample.json";
import snapshot from "@/data/roster.json";
import { transformRoster, validateRoster, type RawCommittee, type RawLegislator, type RawMembership } from "@/lib/ingest/roster";
import type { Member, RosterSnapshot } from "@/lib/types";

const members = transformRoster(
  fixture.legislators as RawLegislator[],
  fixture.committees as RawCommittee[],
  fixture.membership as RawMembership,
);
const byId = Object.fromEntries(members.map((m) => [m.bioguideId, m]));

describe("transformRoster", () => {
  it("uses the latest term for seat and party", () => {
    const cantwell = byId.C000127;
    expect(cantwell.chamber).toBe("senate");
    expect(cantwell.state).toBe("WA");
    expect(cantwell.district).toBeNull();
    expect(cantwell.party).toBe("D");
  });

  it("counts service from the first term in the current chamber, not the first term overall", () => {
    // Cantwell served in the House from 1993 before joining the Senate in 2001.
    expect(byId.C000127.servingSince).toBe("2001");
  });

  it("maps independents and at-large seats", () => {
    expect(byId.S000033.party).toBe("I");
    expect(byId.N000147.district).toBe(0);
  });

  it("attaches full-committee seats with leadership titles and skips subcommittees", () => {
    const seats = byId.C000127.committees;
    expect(seats).toContainEqual({ committeeId: "SSCM", name: "Commerce, Science, and Transportation", title: "Ranking Member" });
    expect(seats.every((s) => !/\d/.test(s.committeeId))).toBe(true);
  });
});

function fakeSenate(n: number): Member[] {
  return Array.from({ length: n }, (_, i) => ({
    ...byId.C000127,
    bioguideId: `S${String(i).padStart(6, "0")}`,
    state: `S${Math.floor(i / 2)}`,
  }));
}
function fakeHouse(n: number): Member[] {
  return Array.from({ length: n }, (_, i) => ({ ...byId.A000055, bioguideId: `H${String(i).padStart(6, "0")}`, district: i + 1 }));
}

describe("validateRoster", () => {
  const today = new Date("2026-10-17");

  it("accepts a complete roster", () => {
    expect(validateRoster([...fakeSenate(100), ...fakeHouse(433)], today)).toEqual([]);
  });

  it("rejects a truncated file", () => {
    const errors = validateRoster([...fakeSenate(40), ...fakeHouse(433)], today);
    expect(errors.join()).toMatch(/Senate has only 40/);
  });

  it("rejects duplicates, impossible seat counts and expired terms", () => {
    const senate = fakeSenate(100);
    senate[1] = { ...senate[1], state: senate[0].state };
    senate[2] = { ...senate[2], state: senate[0].state, termEnd: "2025-01-03" };
    const house = fakeHouse(433);
    house.push({ ...house[0] });
    const errors = validateRoster([...senate, ...house], today).join("\n");
    expect(errors).toMatch(/Duplicate bioguide id H000000/);
    expect(errors).toMatch(/S0 has 3 senators/);
    expect(errors).toMatch(/term that ended 2025-01-03/);
    expect(errors).toMatch(/Two members hold/);
  });
});

describe("committed snapshot", () => {
  const snap = snapshot as RosterSnapshot;
  it("passes validation and records where it came from", () => {
    expect(validateRoster(snap.members, new Date(snap.provenance.fetchedAt))).toEqual([]);
    expect(snap.provenance.files).toHaveLength(3);
    for (const f of snap.provenance.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
