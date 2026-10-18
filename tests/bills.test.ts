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
  readWholeList,
  toMemberBills,
  unconfirmedError,
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
  it("reads to the end of the list, even past items from earlier Congresses", () => {
    expect(needsNextPage(klobSponsored)).toBe(true);
    expect(needsNextPage(pelosiSponsored)).toBe(true);
    expect(needsNextPage(asLastPage(klobSponsored))).toBe(false);
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
    // Seven bills share 2026-09-30; ties are ordered by number, so the window is stable.
    expect(co.links.slice(0, 7).map((l) => l.bill.label)).toEqual(["S. 5665", "S. 5656", "S. 5614", "S.Res. 946", "S.Res. 945", "S.Res. 931", "S.J.Res. 220"]);
  });

  it("accepts a list that isn't in date order, and sorts it newest first", () => {
    const p = parseLegislation([asLastPage(allenSponsored)], "sponsored", "A000372", 119, today);
    expect(p.errors).toEqual([]);
    expect(p.links).toHaveLength(11);
    expect(p.amendments).toBe(0);
    expect(p.links.map((l) => l.date).slice(0, 3)).toEqual(["2026-09-10", "2026-07-21", "2026-03-12"]);
    expect(p.links[0].bill.label).toBe("H.Res. 1521");
    expect(p.links.at(-1)!.bill.label).toBe("H.R. 4122");
  });

  it("keeps current-Congress items listed after an earlier Congress's", () => {
    // Live lists do this: a 118th-Congress amendment, then more 119th-Congress bills.
    const items = [...allenSponsored.items];
    const first = items.splice(0, 1);
    const p = parseLegislation([asLastPage({ ...allenSponsored, items: [...items, ...first] })], "sponsored", "A000372", 119, today);
    expect(p.errors).toEqual([]);
    expect(p.links.map((l) => l.bill.label)).toContain("H.R. 4214");
    expect(p.links).toHaveLength(11);
  });

  it("returns nothing for a member with no bills in the current Congress", () => {
    const p = parseLegislation([asLastPage(pelosiSponsored)], "sponsored", "P000197", 119, today);
    expect(p.errors).toEqual([]);
    expect(p.links).toEqual([]);
  });

  it("rejects a list that ends short of the count Congress.gov reports", () => {
    const p = parseLegislation([{ ...klobSponsored, next: null }], "sponsored", "K000367", 119, today);
    expect(p.errors.join()).toMatch(/read 8 distinct items but Congress.gov reports 1433/);
  });

  it("rejects a list that stopped paging too early", () => {
    const p = parseLegislation([klobSponsored], "sponsored", "K000367", 119, today);
    expect(p.errors.join()).toMatch(/stopped before the end of the list/);
  });

  it("rejects repeats, future dates and unrecognisable bills", () => {
    const [a, b] = klobSponsored.items;
    const page = (items: Record<string, unknown>[]) => [{ items, count: items.length, next: null }];
    // A repeat counts once, so the item it pushed out of the read shows up as missing.
    expect(parseLegislation([{ items: [a, a], count: 2, next: null }], "sponsored", "K000367", 119, today).errors.join()).toMatch(/read 1 distinct items but Congress.gov reports 2/);
    // That holds for an earlier-Congress item repeated across a page boundary too.
    const old = pelosiSponsored.items[0];
    const pages = [
      { items: [a, old], count: 3, next: "page 2" },
      { items: [old], count: 3, next: null },
    ];
    expect(parseLegislation(pages, "sponsored", "K000367", 119, today).errors.join()).toMatch(/read 2 distinct items but Congress.gov reports 3/);
    // A second read that returns the missing item completes the list, and the repeats are merged.
    const reread = [...pages, { items: [b, a], count: 3, next: "page 2" }, { items: [old], count: 3, next: null }];
    const merged = parseLegislation(reread, "sponsored", "K000367", 119, today);
    expect(merged.errors).toEqual([]);
    expect(merged.links.map((l) => l.bill.id).sort()).toEqual([a, b].map((i) => `119-${String(i.type).toLowerCase()}-${i.number}`).sort());
    // More distinct items than reported means the list changed between reads.
    expect(parseLegislation(page([a, b, old]).map((p) => ({ ...p, count: 2 })), "sponsored", "K000367", 119, today).errors.join()).toMatch(/changed while it was being read/);
    // An item removed mid-read shifts the next one past the offset; the count changing between pages gives it away.
    const shrunk = [
      { items: [a, old], count: 4, next: "page 2" },
      { items: [b], count: 3, next: null },
    ];
    expect(parseLegislation(shrunk, "sponsored", "K000367", 119, today).errors.join()).toMatch(/changed while it was being read \(count went from 4 to 3\)/);
    // A malformed item from an earlier Congress isn't kept, so it isn't an error.
    const broken = { ...old, url: undefined, introducedDate: null };
    expect(parseLegislation(page([a, broken]), "sponsored", "K000367", 119, today).errors).toEqual([]);
    // Without a URL it's still keyed by bill, so a repeat across reads counts once and the gap shows.
    expect(parseLegislation([{ items: [a, broken, broken], count: 3, next: null }], "sponsored", "K000367", 119, today).errors.join()).toMatch(/read 2 distinct items but Congress.gov reports 3/);
    expect(parseLegislation(page([a, { congress: 118 }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/no URL or bill number/);
    expect(parseLegislation(page([b, a]), "sponsored", "K000367", 119, today).errors).toEqual([]);
    expect(parseLegislation(page([{ ...a, introducedDate: "2027-01-01" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/future/);
    expect(parseLegislation(page([{ ...a, type: "XYZ" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/not a recognisable bill/);
    expect(parseLegislation(page([{ ...a, congress: 120 }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/impossible Congress/);
    expect(parseLegislation(page([{ ...a, title: "" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/no title/);
    expect(parseLegislation(page([{ ...a, url: "https://api.congress.gov/v3/bill/119/s/1" }]), "sponsored", "K000367", 119, today).errors.join()).toMatch(/points at/);
  });
});

describe("readWholeList", () => {
  const item = (n: number) => ({ congress: 118, type: "HR", number: String(n), introducedDate: "2023-05-01", url: `https://api.congress.gov/v3/bill/118/hr/${n}` });
  const items = Array.from({ length: 30 }, (_, i) => item(i + 1));
  /** A server that pages `list()` by offset, `size` a page, calling `list` afresh for every request. */
  const server = (list: () => Record<string, unknown>[], size = 10) => {
    let calls = 0;
    const readPage = async (offset: number) => {
      calls++;
      const all = list();
      const page: LegislationPage = { items: all.slice(offset, offset + size), count: all.length, next: offset + size < all.length ? "more" : null };
      return { page, source: offset };
    };
    return { readPage, calls: () => calls };
  };
  const parse = (pages: LegislationPage[]) => parseLegislation(pages, "sponsored", "T000001", 119, today);
  // A seeded shuffle, so the test doesn't depend on Math.random.
  const shuffler = (seed: number) => () => {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const j = seed % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  it("reads a stable list once", async () => {
    const s = server(() => items);
    const list = await readWholeList("T000001 sponsored", s.readPage);
    expect(list?.reads).toBe(1);
    expect(s.calls()).toBe(3);
    expect(parse(list!.pages).errors).toEqual([]);
  });

  it("reads a reshuffling list again until every item has come back", async () => {
    const list = await readWholeList("T000001 sponsored", server(shuffler(7)).readPage, 20);
    expect(list!.reads).toBeGreaterThan(1);
    expect(list!.confirmed).toBe(true);
    expect(list!.sources.length).toBe(list!.reads * 3);
    expect(parse(list!.pages).errors).toEqual([]);
  });

  it("drops earlier reads when the count changes, and fails if the gap never fills", async () => {
    let n = 0;
    // Item 30 is withdrawn after the first request, so the first read's count disagrees with itself.
    const s = server(() => (n++ < 1 ? items : items.slice(0, 29)));
    const list = await readWholeList("T000001 sponsored", s.readPage);
    // Read 2 is complete on its own but follows a dropped read, so read 3 confirms it.
    expect(list!.reads).toBe(3);
    expect(list!.confirmed).toBe(true);
    expect(list!.pages.every((p) => p.count === 29)).toBe(true);
    expect(parse(list!.pages).errors).toEqual([]);

    const stuck = server(() => [...items.slice(0, 29), item(1)]);
    const short = await readWholeList("T000001 sponsored", stuck.readPage, 4);
    expect(short!.reads).toBe(4);
    expect(short!.confirmed).toBe(false);
    expect(parse(short!.pages).errors.join()).toMatch(/read 29 distinct items but Congress.gov reports 30/);
  });

  it("starts over when a confirming read turns up an item the others never returned", async () => {
    const [a, b, x, y] = [item(1), item(2), item(3), item(4)];
    // Read 1 misses B; then X is withdrawn and Y added (count stays 3); read 2 misses Y.
    const passes = [[a, x, a], [b, a, b], [a, b, y], [y, b, a]];
    let n = 0;
    const s = server(() => passes[Math.min(n++, passes.length - 1)], 250);
    const list = await readWholeList("T000001 sponsored", s.readPage);
    expect(list!.confirmed).toBe(true);
    expect(list!.reads).toBe(4);
    const p = parse(list!.pages);
    expect(p.errors).toEqual([]);
    const keys = new Set(list!.pages.flatMap((pg) => pg.items.map((i) => i.url)));
    expect([...keys].sort()).toEqual([a, b, y].map((i) => i.url).sort());
  });

  it("doesn't confirm a list until every item has come back again", async () => {
    const [a, b, x, y] = [item(1), item(2), item(3), item(4)];
    // X is withdrawn and Y added after read 1; the confirming read misses Y too, but X never returns.
    const passes = [[a, x, a], [b, a, b], [a, b, a], [b, b, a]];
    let n = 0;
    const list = await readWholeList("T000001 sponsored", server(() => passes[Math.min(n++, passes.length - 1)], 250).readPage);
    expect(list!.confirmed).toBe(false);
    // The merged {A, X, B} matches the count, so the parser passes it; only the unconfirmed error blocks it.
    expect(parse(list!.pages).errors).toEqual([]);
    expect(unconfirmedError("T000001 sponsored", list!)).toMatch(/complete but not confirmed after 12 reads/);
    // A later read that returns Y starts over and settles on the real list.
    const later = [...passes.slice(0, 3), [y, a, b], [a, y, b]];
    let m = 0;
    const fixed = await readWholeList("T000001 sponsored", server(() => later[Math.min(m++, later.length - 1)], 250).readPage);
    expect(fixed!.confirmed).toBe(true);
    expect(new Set(fixed!.pages.flatMap((pg) => pg.items.map((i) => i.url)))).toEqual(new Set([a, b, y].map((i) => i.url)));
  });

  it("starts over when merged reads hold more items than the count", async () => {
    const [a, b, x, y] = [item(1), item(2), item(3), item(4)];
    // X is withdrawn and Y added between reads 1 and 2 (count stays 3), so the merge holds four items.
    const passes = [[a, x, a], [b, y, b], [a, b, y], [y, a, b]];
    let n = 0;
    const list = await readWholeList("T000001 sponsored", server(() => passes[Math.min(n++, passes.length - 1)], 250).readPage);
    expect(list!.confirmed).toBe(true);
    expect(list!.reads).toBe(4);
    expect(parse(list!.pages).errors).toEqual([]);
    expect(new Set(list!.pages.flatMap((pg) => pg.items.map((i) => i.url)))).toEqual(new Set([a, b, y].map((i) => i.url)));
  });

  it("drops a read whose own pages disagree on the count once a later read does", async () => {
    // An item is added during read 1's second page and withdrawn again before read 2.
    let n = 0;
    const s = server(() => (++n === 2 ? [...items, item(31)] : items));
    const list = await readWholeList("T000001 sponsored", s.readPage);
    expect(list!.confirmed).toBe(true);
    expect(list!.reads).toBe(3);
    expect(parse(list!.pages).errors).toEqual([]);
  });

  it("reports an unconfirmed list when the reads run out", async () => {
    const [a, b, x] = [item(1), item(2), item(3)];
    const passes = [[a, x, a], [b, a, b]];
    let n = 0;
    const list = await readWholeList("T000001 sponsored", server(() => passes[Math.min(n++, 1)], 250).readPage, 2);
    expect(list!.confirmed).toBe(false);
    expect(unconfirmedError("T000001 sponsored", list!)).toMatch(/complete but not confirmed after 2 reads/);
    const short = { pages: [{ items: [item(1)], count: 3, next: null }], reads: 12, confirmed: false };
    expect(unconfirmedError("T000001 sponsored", short)).toMatch(/still short after 12 reads \(1 of 3 items\)/);
    expect(unconfirmedError("T000001 sponsored", { ...short, confirmed: true })).toBeNull();
  });

  it("returns null for a member with no list, but throws on a 404 partway through", async () => {
    expect(await readWholeList("T000001 sponsored", async () => null)).toBeNull();
    const s = server(() => items);
    await expect(readWholeList("T000001 sponsored", async (o) => (o === 0 ? s.readPage(o) : null))).rejects.toThrow(/404 partway/);
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
