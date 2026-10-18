import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import roster from "@/data/roster.json";
import financeSnapshot from "@/data/finance.json";
import {
  candidateTotalsUrl,
  candidatesTotalsUrl,
  fecCycle,
  isCongressionalId,
  parseCandidateTotals,
  readBatch,
  receiptParts,
  toMemberFinance,
  validateFinanceSnapshot,
} from "@/lib/ingest/finance";
import { fmtUsdShort } from "@/lib/format";
import type { CampaignTotals, FinanceSnapshot, RosterSnapshot } from "@/lib/types";

// Real responses from api.open.fec.gov, saved unmodified apart from indentation.
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(__dirname, "fixtures", "finance", name), "utf8"));
const today = new Date("2026-10-18");
const fetchedAt = "2026-10-18T11:00:00.000Z";
const asked = ["H8CA05035", "S6MN00267", "S4VT00033", "H8VT01016"];
const batch = readBatch(fixture("candidates-totals-2026.json"), asked, 2026);
const batchRow = (id: string) => batch.rows.find((r) => r.candidateId === id);
const meta = (id: string) => ({ sourceUrl: candidateTotalsUrl(id, 2026), sha256: "a".repeat(64), fetchedAt });
const parse = (id: string, body: unknown = fixture(`candidate-${id}.json`), row = batchRow(id)) => parseCandidateTotals(body, id, 2026, row, meta(id), today);

/** The detailed fixture with one field of its only record changed. */
const withField = (id: string, field: string, value: unknown) => {
  const body = fixture(`candidate-${id}.json`);
  const [r] = body.results as Record<string, unknown>[];
  return { ...body, results: [{ ...r, [field]: value }] };
};

describe("fecCycle", () => {
  it("uses the even year's cycle, and the one just ended until the first reports of a new cycle are in", () => {
    expect(fecCycle(new Date("2026-10-18"))).toBe(2026);
    expect(fecCycle(new Date("2027-02-01"))).toBe(2026);
    expect(fecCycle(new Date("2027-05-01"))).toBe(2028);
    expect(fecCycle(new Date("2028-01-05"))).toBe(2028);
  });
});

describe("URLs", () => {
  it("never carry the API key", () => {
    expect(candidatesTotalsUrl(["H8CA05035", "S6MN00267"], 2026)).toBe(
      "https://api.open.fec.gov/v1/candidates/totals/?candidate_id=H8CA05035&candidate_id=S6MN00267&cycle=2026&election_full=false&per_page=100",
    );
    expect(candidateTotalsUrl("H8CA05035", 2026)).not.toMatch(/api_key/);
  });

  it("keep House and Senate campaigns only", () => {
    expect(isCongressionalId("H8CA05035")).toBe(true);
    expect(isCongressionalId("S4VT00033")).toBe(true);
    expect(isCongressionalId("P60007168")).toBe(false);
  });
});

describe("readBatch", () => {
  it("returns a row per candidate with totals this cycle and leaves out the rest", () => {
    expect(batch.errors).toEqual([]);
    expect(batch.rows.map((r) => r.candidateId)).toEqual(["S4VT00033", "S6MN00267", "H8CA05035"]);
    // Cash on hand comes back as a string; the reader turns it into a number.
    expect(batchRow("H8CA05035")).toMatchObject({ receipts: 2467978.64, cashOnHand: 384308.83, coverageEnd: "2026-09-30" });
  });

  it("leaves out old candidate ids that the FEC lists with nothing filed this cycle", () => {
    const body = fixture("candidates-totals-2026-no-reports.json");
    expect(readBatch(body, ["H8WI00018", "H6IN03229"], 2026)).toEqual({ rows: [], errors: [] });
    const [r] = body.results as Record<string, unknown>[];
    const odd = { ...body, results: [{ ...r, receipts: 500 }], pagination: { count: 1, pages: 1 } };
    expect(readBatch(odd, ["H6IN03229"], 2026).errors.join()).toMatch(/H6IN03229 has money but no coverage dates/);
  });

  it("rejects rows nobody asked for, repeats, the wrong cycle and incomplete pages", () => {
    const body = fixture("candidates-totals-2026.json");
    const rows = body.results as Record<string, unknown>[];
    expect(readBatch(body, ["H8CA05035"], 2026).errors.join()).toMatch(/S4VT00033, which wasn't asked for/);
    expect(readBatch(body, asked, 2024).errors.join()).toMatch(/cycle 2026, not 2024/);
    const twice = { ...body, results: [rows[0], rows[0]], pagination: { count: 2, pages: 1 } };
    expect(readBatch(twice, asked, 2026).errors.join()).toMatch(/lists S4VT00033 twice/);
    expect(() => readBatch({ ...body, pagination: { count: 120, pages: 2 } }, asked, 2026)).toThrow(/incomplete/);
    expect(() => readBatch({ error: "API_KEY_INVALID" }, asked, 2026)).toThrow();
  });
});

describe("parseCandidateTotals", () => {
  it("reads the full breakdown, to the cent", () => {
    const p = parse("H8CA05035");
    expect(p.errors).toEqual([]);
    expect(p.totals).toMatchObject({
      candidateId: "H8CA05035",
      office: "H",
      electionYear: 2026,
      cycle: 2026,
      coverageStart: "2025-01-01",
      coverageEnd: "2026-09-30",
      lastReport: "OCTOBER QUARTERLY 2026",
      receipts: 2467978.64,
      disbursements: 4161736.27,
      cashOnHand: 384308.83,
      debts: 0,
      individualItemized: 808796.43,
      individualUnitemized: 1411326.97,
      otherCommittees: 33000,
      transfersIn: 141138.4,
      // Other receipts plus offsets to operating expenditures.
      otherReceipts: 73716.84,
      pageUrl: "https://www.fec.gov/data/candidate/H8CA05035/?cycle=2026&election_full=false",
      sourceUrl: "https://api.open.fec.gov/v1/candidate/H8CA05035/totals/?cycle=2026&election_full=false",
    });
  });

  it("passes the line arithmetic and the cross-check for every fixture", () => {
    for (const id of ["H8CA05035", "S6MN00267", "S4VT00033"]) expect(parse(id).errors).toEqual([]);
    expect(parse("S4VT00033").totals).toMatchObject({ office: "S", electionYear: 2030, receipts: 26324335.09 });
  });

  it("rejects a record whose lines don't add up to its totals", () => {
    expect(parse("H8CA05035", withField("H8CA05035", "individual_unitemized_contributions", 1411000)).errors.join()).toMatch(/individual contributions .* don't equal/);
    expect(parse("H8CA05035", withField("H8CA05035", "other_receipts", 50000)).errors.join()).toMatch(/total receipts/);
    expect(parse("H8CA05035", withField("H8CA05035", "other_disbursements", 0)).errors.join()).toMatch(/total disbursements/);
    expect(parse("H8CA05035", withField("H8CA05035", "loans_made_by_candidate", 5000)).errors.join()).toMatch(/loans/);
  });

  it("rejects a record that disagrees with the batch totals", () => {
    const row = { ...batchRow("H8CA05035")!, receipts: 2467000 };
    expect(parse("H8CA05035", undefined, row).errors.join()).toMatch(/receipts is \$2,467,978.64 in the candidate record but \$2,467,000.00/);
    const late = { ...batchRow("H8CA05035")!, coverageEnd: "2026-06-30" };
    expect(parse("H8CA05035", undefined, late).errors.join()).toMatch(/coverage ends 2026-09-30 .* but 2026-06-30/);
    expect(parseCandidateTotals(fixture("candidate-H8CA05035.json"), "H8CA05035", 2026, undefined, meta("H8CA05035"), today).errors.join()).toMatch(/not in the candidates\/totals results/);
  });

  it("rejects the wrong candidate, the wrong cycle, whole-election totals, and missing or negative figures", () => {
    expect(parse("S6MN00267", fixture("candidate-H8CA05035.json")).errors.join()).toMatch(/record is for H8CA05035/);
    expect(parse("H8CA05035", withField("H8CA05035", "cycle", 2024)).errors.join()).toMatch(/cycle 2024/);
    expect(parse("H8CA05035", withField("H8CA05035", "election_full", true)).errors.join()).toMatch(/whole election/);
    expect(parse("H8CA05035", withField("H8CA05035", "receipts", null)).errors.join()).toMatch(/receipts is missing/);
    expect(parse("H8CA05035", withField("H8CA05035", "loans", -5)).errors.join()).toMatch(/loans is negative/);
    expect(parse("H8CA05035", withField("H8CA05035", "coverage_end_date", "2027-03-31T00:00:00")).errors.join()).toMatch(/outside the 2025–2026 cycle/);
  });
});

describe("receiptParts", () => {
  it("adds up to the campaign's receipts", () => {
    for (const id of ["H8CA05035", "S6MN00267", "S4VT00033"]) {
      const c = parse(id).totals!;
      const sum = receiptParts(c).reduce((n, p) => n + p.amount, 0);
      expect(Math.abs(sum - c.receipts)).toBeLessThan(0.005);
    }
  });
});

describe("toMemberFinance", () => {
  it("puts the campaign for the member's seat first", () => {
    const house = parse("H8CA05035").totals!;
    const senate = parse("S4VT00033").totals!;
    expect(toMemberFinance({ chamber: "house" }, [senate, house], fetchedAt).campaigns.map((c) => c.office)).toEqual(["H", "S"]);
    expect(toMemberFinance({ chamber: "senate" }, [house, senate], fetchedAt).campaigns.map((c) => c.office)).toEqual(["S", "H"]);
  });
});

describe("validateFinanceSnapshot", () => {
  const build = (): FinanceSnapshot => {
    const t = (id: string) => parse(id).totals!;
    return {
      provenance: { source: "the FEC", sourceHome: "https://www.fec.gov/data/", fetchedAt, cycle: 2026 },
      sources: [{ url: candidatesTotalsUrl(asked, 2026), sha256: "b".repeat(64) }],
      members: {
        P000197: toMemberFinance({ chamber: "house" }, [t("H8CA05035")], fetchedAt),
        K000367: toMemberFinance({ chamber: "senate" }, [t("S6MN00267")], fetchedAt),
        S000033: toMemberFinance({ chamber: "senate" }, [t("S4VT00033")], fetchedAt),
      },
    };
  };
  const ids = ["P000197", "K000367", "S000033"];

  it("accepts a well-formed snapshot", () => {
    expect(validateFinanceSnapshot(build(), ids, null)).toEqual([]);
  });

  it("rejects a snapshot where too few members have reports", () => {
    const snap = build();
    snap.members.K000367.campaigns = [];
    expect(validateFinanceSnapshot(snap, ids, null).join()).toMatch(/Only 2 of 3 members/);
  });

  it("rejects one campaign credited to two members", () => {
    const snap = build();
    snap.members.X000001 = snap.members.P000197;
    expect(validateFinanceSnapshot(snap, ids, null).join()).toMatch(/H8CA05035 is credited to both/);
  });

  it("rejects reports that went backwards since the last pull, within the same cycle", () => {
    const prev = build();
    const snap = build();
    snap.members.P000197.campaigns[0].coverageEnd = "2026-06-30";
    expect(validateFinanceSnapshot(snap, ids, prev).join()).toMatch(/reports now end 2026-06-30, earlier than 2026-09-30/);
    prev.provenance.cycle = 2024;
    expect(validateFinanceSnapshot(snap, ids, prev)).toEqual([]);
  });

  it("rejects an API key in a stored URL and a record with no source", () => {
    const leaked = build();
    leaked.sources[0].url += "&api_key=abc";
    expect(validateFinanceSnapshot(leaked, ids, null).join()).toMatch(/API key/);
    const unsourced = build();
    unsourced.members.S000033.campaigns[0].sha256 = "";
    expect(validateFinanceSnapshot(unsourced, ids, null).join()).toMatch(/S000033: S4VT00033 has no source hash/);
  });
});

describe("fmtUsdShort", () => {
  it("rounds headline figures without overflowing a unit", () => {
    expect(fmtUsdShort(2467978.64)).toBe("$2.5M");
    expect(fmtUsdShort(384308.83)).toBe("$384K");
    expect(fmtUsdShort(999_700)).toBe("$1M");
    expect(fmtUsdShort(950)).toBe("$950");
    expect(fmtUsdShort(0)).toBe("$0");
  });
});

describe("committed snapshot", () => {
  const snap = financeSnapshot as unknown as FinanceSnapshot;
  it("is either the empty seed or a snapshot that passes validation", () => {
    if (snap.provenance.fetchedAt === null) {
      expect(Object.keys(snap.members)).toHaveLength(0);
      return;
    }
    const ids = (roster as RosterSnapshot).members.filter((m) => m.fecIds.some(isCongressionalId)).map((m) => m.bioguideId);
    expect(validateFinanceSnapshot(snap, ids, null)).toEqual([]);
    const all = Object.values(snap.members).flatMap((m) => m.campaigns) as CampaignTotals[];
    for (const c of all) expect(Math.abs(receiptParts(c).reduce((n, p) => n + p.amount, 0) - c.receipts)).toBeLessThan(1);
  });
});
