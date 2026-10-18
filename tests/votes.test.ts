import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import roster from "@/data/roster.json";
import votesSnapshot from "@/data/votes.json";
import {
  congressForYear,
  isHouseVoteXml,
  measureRef,
  mergeVotes,
  parseHouseVote,
  parseSenateMenu,
  parseSenateVote,
  toVote,
  validateVote,
  validateVotesSnapshot,
  type ParsedVote,
} from "@/lib/ingest/votes";
import type { RosterSnapshot, Vote, VotesSnapshot } from "@/lib/types";

// Real files from clerk.house.gov and senate.gov, saved unmodified (the Senate menu is trimmed to five votes).
const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "votes", name), "utf8");
const lisToBioguide = new Map((roster as RosterSnapshot).members.filter((m) => m.lisId).map((m) => [m.lisId!, m.bioguideId]));

const house250 = parseHouseVote(fixture("house-2026-roll250.xml"), 2026, "https://clerk.house.gov/evs/2026/roll250.xml");
const quorum = parseHouseVote(fixture("house-2026-roll001.xml"), 2026, "https://clerk.house.gov/evs/2026/roll001.xml");
const senate256 = parseSenateVote(
  fixture("senate-119-2-00256.xml"),
  "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00256.xml",
  lisToBioguide,
);
const today = new Date("2026-10-17");

describe("parseHouseVote", () => {
  it("reads the metadata, measure and official totals", () => {
    expect(house250).toMatchObject({
      id: "house-2026-250",
      congress: 119,
      session: 2,
      rollNumber: 250,
      date: "2026-07-20",
      time: "19:02",
      question: "On Motion to Suspend the Rules and Pass, as Amended",
      description: "EARLY Act Reauthorization",
      measure: "H.R. 4541",
      measureUrl: "https://www.congress.gov/bill/119th-congress/house-bill/4541",
      result: "Passed",
      totals: { yea: 394, nay: 6, present: 0, notVoting: 31 },
      pageUrl: "https://clerk.house.gov/Votes/2026250",
    });
  });

  it("keys positions by bioguide id", () => {
    expect(house250.positions.A000370).toBe("Yea"); // Alma Adams
    expect(Object.keys(house250.positions)).toHaveLength(431);
  });

  it("treats a quorum call as procedural, with no measure", () => {
    expect(quorum.measure).toBeNull();
    expect(quorum.totals).toEqual({ yea: 0, nay: 0, present: 406, notVoting: 24 });
    expect(validateVote(quorum, today)).toEqual([]);
  });

  it("recognises the Clerk's error document for a roll call that doesn't exist yet", () => {
    expect(isHouseVoteXml(`<xml>Error sanitizing file "roll999.xml". Please try again.</xml>`)).toBe(false);
    expect(isHouseVoteXml(fixture("house-2026-roll250.xml"))).toBe(true);
  });
});

describe("parseSenateVote", () => {
  it("maps every senator from LIS id to bioguide id", () => {
    expect(senate256.unmatched).toEqual([]);
    expect(Object.keys(senate256.positions)).toHaveLength(100);
    expect(senate256.positions.C000127).toBe("Nay"); // Cantwell, LIS S275
  });

  it("reads the date, nomination and totals, treating blank counts as zero", () => {
    expect(senate256).toMatchObject({
      id: "senate-119-2-256",
      date: "2026-09-30",
      time: "21:29",
      question: "On the Nomination",
      measure: "PN1129",
      measureUrl: "https://www.congress.gov/nomination/119th-congress/1129",
      result: "Nomination Confirmed",
      totals: { yea: 47, nay: 41, present: 0, notVoting: 12 },
      pageUrl: "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00256.htm",
    });
  });

  it("lists roll numbers from the vote menu, newest first", () => {
    expect(parseSenateMenu(fixture("senate-menu-119-2.xml"))).toEqual([256, 255, 254, 253, 252]);
  });
});

describe("validateVote", () => {
  it("accepts real votes whose positions add up to the official totals", () => {
    expect(validateVote(house250, today)).toEqual([]);
    expect(validateVote(senate256, today)).toEqual([]);
  });

  it("rejects a vote whose positions don't match the official totals", () => {
    const tampered: ParsedVote = { ...house250, positions: { ...house250.positions, A000370: "Nay" } };
    const errors = validateVote(tampered, today).join("\n");
    expect(errors).toMatch(/yea count 393 does not match the official total 394/);
    expect(errors).toMatch(/nay count 7 does not match the official total 6/);
  });

  it("rejects a truncated file", () => {
    const ids = Object.keys(senate256.positions).slice(0, 40);
    const truncated: ParsedVote = { ...senate256, recorded: 40, positions: Object.fromEntries(ids.map((id) => [id, senate256.positions[id]])) };
    expect(validateVote(truncated, today).join()).toMatch(/40 members recorded, expected 90–100/);
  });

  it("rejects a Senate vote when the roster can't place several senators", () => {
    const partial = parseSenateVote(fixture("senate-119-2-00256.xml"), "u", new Map([...lisToBioguide].slice(10)));
    expect(validateVote(partial, today).join()).toMatch(/10 members not on the roster/);
  });

  it("rejects duplicates, unreadable dates and future dates", () => {
    expect(validateVote({ ...house250, duplicates: ["A000370"] }, today).join()).toMatch(/recorded twice: A000370/);
    expect(validateVote({ ...house250, date: "2026-??-20" }, today).join()).toMatch(/unreadable date/);
    expect(validateVote({ ...house250, date: "2027-01-01" }, today).join()).toMatch(/in the future/);
  });

  it("rejects positions it couldn't read, or that don't fit yea/nay totals", () => {
    const blank: ParsedVote = { ...house250, positions: Object.fromEntries(Object.keys(house250.positions).map((id) => [id, ""])) };
    expect(validateVote(blank, today).join()).toMatch(/431 members have no recorded position/);
    const odd: ParsedVote = { ...house250, positions: { ...house250.positions, A000370: "Jeffries" } };
    expect(validateVote(odd, today).join()).toMatch(/1 positions don't fit the official totals/);
  });

  it("skips the totals check for the election of a Speaker, where positions are candidate names", () => {
    const speaker: ParsedVote = {
      ...house250,
      totals: null,
      positions: Object.fromEntries(Object.keys(house250.positions).map((id, i) => [id, i % 2 ? "Johnson (LA)" : "Jeffries"])),
    };
    expect(validateVote(speaker, today)).toEqual([]);
  });
});

describe("measureRef", () => {
  it("normalises House and Senate measure numbers", () => {
    expect(measureRef("H RES 123", 119)).toEqual({ measure: "H.Res. 123", measureUrl: "https://www.congress.gov/bill/119th-congress/house-resolution/123" });
    expect(measureRef("S.J.Res. 4", 119).measureUrl).toBe("https://www.congress.gov/bill/119th-congress/senate-joint-resolution/4");
    expect(measureRef("QUORUM", 119)).toEqual({ measure: null, measureUrl: null });
    expect(measureRef("", 119)).toEqual({ measure: null, measureUrl: null });
  });
});

describe("congressForYear", () => {
  it("maps a calendar year to its Congress and session", () => {
    expect(congressForYear(2025)).toEqual({ congress: 119, session: 1 });
    expect(congressForYear(2026)).toEqual({ congress: 119, session: 2 });
    expect(congressForYear(2027)).toEqual({ congress: 120, session: 1 });
  });
});

describe("mergeVotes", () => {
  const stamp = (v: ParsedVote, roll: number): Vote => toVote({ ...v, id: `${v.chamber}-x-${roll}`, rollNumber: roll }, "0".repeat(64), "2026-10-17T00:00:00Z");

  it("keeps the newest votes per chamber and lets a refetched vote replace the old copy", () => {
    const old = [1, 2, 3].map((n) => stamp(house250, n));
    const fresh = [stamp(house250, 4), { ...stamp(house250, 3), result: "Failed" }, stamp(senate256, 9)];
    const merged = mergeVotes(old, fresh, 3);
    expect(merged.filter((v) => v.chamber === "house").map((v) => v.rollNumber)).toEqual([4, 3, 2]);
    expect(merged.find((v) => v.rollNumber === 3)?.result).toBe("Failed");
    expect(merged.filter((v) => v.chamber === "senate")).toHaveLength(1);
  });
});

describe("committed snapshot", () => {
  const snap = votesSnapshot as unknown as VotesSnapshot;
  it("is either the empty seed or a snapshot that passes validation", () => {
    if (snap.provenance.fetchedAt === null) {
      expect(snap.votes).toEqual([]);
      return;
    }
    expect(validateVotesSnapshot(snap)).toEqual([]);
  });
});
