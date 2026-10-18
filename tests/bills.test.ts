import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import roster from "@/data/roster.json";
import billsSnapshot from "@/data/bills.json";
import {
  checkCosponsor,
  checkSponsor,
  memberLegislationUrl,
  needsNextPage,
  parseLegislation,
  readLegislationPage,
  toMemberBills,
  validateBillsSnapshot,
  type LegislationPage,
} from "@/lib/ingest/bills";
import type { Bill, BillsSnapshot, RosterSnapshot } from "@/lib/types";

// Real responses from api.congress.gov, saved unmodified apart from indentation.
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, "fixtures", "bills", name), "utf8"));
const today = new Date("2026-10-18");

const klobSponsored = readLegislationPage(fixture("K000367-sponsored.json"), "sponsored");
const klobCosponsored = readLegislationPage(fixture("K000367-cosponsored.json"), "cosponsored");
const pelosiSponsored = readLegislationPage(fixture("P000197-sponsored.json"), "sponsored");
// Real page that is not in date order within the 119th Congress and ends with a 118th-Congress amendment.
const allenSponsored = readLegislationPage(fixture("A000372-sponsored.json"), "sponsored");

/** The same page as if it were the last one, with the count matching what it lists. */
const asLastPage = (p: LegislationPage): LegislationPage => ({ ...p, next: null, count: p.items.length });

describe("readLegislationPage", () => {
  it("reads the items, the all-time count and the next page", () => {
    expect(klobSponsored.items).toHaveLength(8);
    expect(klobSponsored.count).toBe(1433);
    expect(klobSponsored.next).toContain("offset=8");
  });

  it("rejects a response of the wrong kind", () => {
    expect(() => readLegislationPage(fixture("K000367-sponsored.json"), "cosponsored")).toThrow();
    expect(() => readLegislationPage({ error: "API_KEY_INVALID" }, "sponsored")).toThrow();
  });
});

describe("needsNextPage", () => {
  it("keeps paging while every item is in the current Congress", () => {
    expect(needsNextPage(klobSponsored, 119)).toBe(true);
  });

  it("stops once a page reaches an earlier Congress", () => {
    expect(needsNextPage(pelosiSponsored, 119)).toBe(false);
  });
});

describe("parseLegislation", () => {
  const sponsored = parseLegislation([asLastPage(klobSponsored)], "sponsored", "K000367", 119, today);

  it("keeps bills and resolutions, counts amendments separately", () => {
    expect(sponsored.errors).toEqual([]);
    expect(sponsored.links).toHaveLength(6);
    expect(sponsored.amendments).toBe(2);
  });

  it("builds labels and Congress.gov links", () => {
    const vital = sponsored.links.find((l) => l.bill.id === "119-s-5285")!;
    expect(vital.date).toBe("2026-08-06");
    expect(vital.bill).toMatchObject({
      label: "S. 5285",
      title: "Visitable Inclusive Tax credits for Accessible Living (VITAL) Act",
      policyArea: "Taxation",
      latestAction: { date: "2026-08-06", text: "Read twice and referred to the Committee on Finance." },
      pageUrl: "https://www.congress.gov/bill/119th-congress/senate-bill/5285",
      sourceUrl: "https://api.congress.gov/v3/bill/119/s/5285",
    });
    expect(sponsored.links[0].bill.pageUrl).toBe("https://www.congress.gov/bill/119th-congress/senate-resolution/908");
  });

  it("uses the sign-on date for cosponsored bills, which can be long after introduction", () => {
    const co = parseLegislation([asLastPage(klobCosponsored)], "cosponsored", "K000367", 119, today);
    expect(co.errors).toEqual([]);
    const s3466 = co.links.find((l) => l.bill.id === "119-s-3466")!;
    expect(s3466.date).toBe("2026-09-29");
    expect(s3466.bill.latestAction?.date).toBe("2025-12-11");
  });

  it("accepts a list that isn't in date order within the Congress, and sorts it newest first", () => {
    expect(needsNextPage(allenSponsored, 119)).toBe(false);
    const p = parseLegislation([allenSponsored], "sponsored", "A000372", 119, today);
    expect(p.errors).toEqual([]);
    expect(p.links).toHaveLength(11);
    expect(p.amendments).toBe(0);
    expect(p.links.map((l) => l.date).slice(0, 3)).toEqual(["2026-09-10", "2026-07-21", "2026-03-12"]);
    expect(p.links[0].bill.label).toBe("H.Res. 1521");
    expect(p.links.at(-1)!.bill.label).toBe("H.R. 4122");
  });

  it("rejects a current-Congress item listed after an earlier Congress, since paging would have missed it", () => {
    const items = [...allenSponsored.items];
    const late = items.splice(0, 1);
    const p = parseLegislation([{ ...allenSponsored, items: [...items, ...late] }], "sponsored", "A000372", 119, today);
    expect(p.errors.join()).toMatch(/out of Congress order/);
  });

  it("returns nothing for a member with no bills in the current Congress", () => {
    const p = parseLegislation([pelosiSponsored], "sponsored", "P000197", 119, today);
    expect(p.errors).toEqual([]);
    expect(p.links).toEqual([]);
  });

  it("rejects a list that ends short of the count Congress.gov reports", () => {
    const p = parseLegislation([{ ...klobSponsored, next: null }], "sponsored", "K000367", 119, today);
    expect(p.errors.join()).toMatch(/ended after 8 items but Congress.gov reports 1433/);
  });

  it("rejects a list that stopped paging too early", () => {
    const p = parseLegislation([klobSponsored], "sponsored", "K000367", 119, today);
    expect(p.errors.join()).toMatch(/stopped before reaching/);
  });

  it("rejects repeats, future dates and unrecognisable bills", () => {
    const [a, b] = klobSponsored.items;
    const page = (items: Record<string, unknown>[]) => [{ items, count: items.length, next: null }];
    expect(parseLegislation(page([a, a]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/listed twice/);
    expect(parseLegislation(page([b, a]), "sponsored", "K000367", 119, today).errors).toEqual([]);
    expect(parseLegislation(page([{ ...a, introducedDate: "2027-01-01" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/future/);
    expect(parseLegislation(page([{ ...a, type: "XYZ" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/not a recognisable bill/);
    expect(parseLegislation(page([{ ...a, congress: 120 }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/impossible Congress/);
    expect(parseLegislation(page([{ ...a, title: "" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/no title/);
    expect(parseLegislation(page([{ ...a, url: "https://api.congress.gov/v3/bill/119/s/1" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/points at/);
  });
});

describe("cross-checks against the bill's own record", () => {
  const sponsored = parseLegislation([asLastPage(klobSponsored)], "sponsored", "K000367", 119, today);
  const vital = sponsored.links.find((l) => l.bill.id === "119-s-5285")!;

  it("confirms the sponsor, date and title", () => {
    expect(checkSponsor(fixture("bill-119-s-5285.json"), vital, "K000367")).toEqual([]);
  });

  it("flags a bill whose record names a different sponsor", () => {
    expect(checkSponsor(fixture("bill-119-s-5285.json"), vital, "S000033").join()).toMatch(/names sponsor K000367/);
    expect(checkSponsor(fixture("bill-119-s-5285.json"), { ...vital, date: "2026-08-07" }, "K000367").join()).toMatch(/introduced/);
  });

  it("confirms a cosponsor and the date they signed on", () => {
    const link = { date: "2026-09-29", bill: { label: "S. 3466" } };
    expect(checkCosponsor([fixture("bill-119-s-3466-cosponsors.json")], link, "K000367")).toEqual([]);
    expect(checkCosponsor([fixture("bill-119-s-3466-cosponsors.json")], { ...link, date: "2025-12-11" }, "K000367").join()).toMatch(/signed on 2026-09-29/);
    expect(checkCosponsor([fixture("bill-119-s-3466-cosponsors.json")], link, "P000197").join()).toMatch(/not on the bill's cosponsor list/);
  });
});

describe("validateBillsSnapshot", () => {
  const fetchedAt = "2026-10-18T09:00:00.000Z";
  const build = (): BillsSnapshot => {
    const bills: Record<string, Bill> = {};
    const s = parseLegislation([asLastPage(klobSponsored)], "sponsored", "K000367", 119, today);
    const c = parseLegislation([asLastPage(klobCosponsored)], "cosponsored", "K000367", 119, today);
    const sources = [{ url: memberLegislationUrl("K000367", "sponsored"), sha256: "a".repeat(64) }];
    const member = toMemberBills(s, c, sources, fetchedAt, bills, 3);
    return {
      provenance: { source: "Congress.gov", sourceHome: "https://www.congress.gov/", fetchedAt, congress: 119, window: 3 },
      bills,
      members: { K000367: member },
    };
  };

  it("accepts a well-formed snapshot and keeps only the window per list", () => {
    const snap = build();
    expect(validateBillsSnapshot(snap, ["K000367"], null)).toEqual([]);
    expect(snap.members.K000367).toMatchObject({ sponsoredCount: 6, cosponsoredCount: 8 });
    expect(snap.members.K000367.sponsored.map((l) => l.billId)).toEqual(["119-sres-908", "119-sres-858", "119-s-5285"]);
    expect(Object.keys(snap.bills)).toHaveLength(6);
  });

  it("rejects a snapshot missing too many members", () => {
    expect(validateBillsSnapshot(build(), ["K000367", "A1", "A2", "A3", "A4"], null).join()).toMatch(/4 members have no bill record/);
  });

  it("rejects a sponsored count that went down within a Congress", () => {
    const prev = build();
    prev.members.K000367.sponsoredCount = 7;
    expect(validateBillsSnapshot(build(), ["K000367"], prev).join()).toMatch(/fell from 7 to 6/);
    prev.provenance.congress = 118;
    expect(validateBillsSnapshot(build(), ["K000367"], prev)).toEqual([]);
  });

  it("rejects a bill with two sponsors, a dangling link, and an API key in a stored URL", () => {
    const snap = build();
    snap.members.X000001 = { ...snap.members.K000367, cosponsored: [] };
    expect(validateBillsSnapshot(snap, ["K000367"], null).join()).toMatch(/sponsored by both K000367 and X000001/);
    const dangling = build();
    delete dangling.bills["119-s-5285"];
    expect(validateBillsSnapshot(dangling, ["K000367"], null).join()).toMatch(/119-s-5285, which is missing/);
    const leaked = build();
    leaked.members.K000367.sources[0].url += "&api_key=abc";
    expect(validateBillsSnapshot(leaked, ["K000367"], null).join()).toMatch(/API key/);
  });
});

describe("committed snapshot", () => {
  const snap = billsSnapshot as unknown as BillsSnapshot;
  it("is either the empty seed or a snapshot that passes validation", () => {
    if (snap.provenance.fetchedAt === null) {
      expect(Object.keys(snap.members)).toHaveLength(0);
      return;
    }
    const ids = (roster as RosterSnapshot).members.map((m) => m.bioguideId);
    expect(validateBillsSnapshot(snap, ids, null)).toEqual([]);
  });
});
