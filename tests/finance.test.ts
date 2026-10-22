import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import roster from "@/data/roster.json";
import financeSnapshot from "@/data/finance.json";
import {
  campaignFromRow,
  candidateTotalsUrl,
  candidatesTotalsUrl,
  fecCycle,
  financeFingerprint,
  isCongressionalId,
  memberFinanceStatus,
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
  it("uses the even year's cycle, and the one just ended until every campaign has reported in the new one", () => {
    expect(fecCycle(new Date("2026-10-18"))).toBe(2026);
    expect(fecCycle(new Date("2027-02-01"))).toBe(2026);
    // House campaigns have filed the April quarterly, but most senators' first report is due July 31.
    expect(fecCycle(new Date("2027-05-01"))).toBe(2026);
    expect(fecCycle(new Date("2027-08-14T23:59:00Z"))).toBe(2026);
    expect(fecCycle(new Date("2027-08-15"))).toBe(2028);
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
    for (const id of ["H8CA05035", "S6MN00267", "S4VT00033"]) expect(parse(id)).toMatchObject({ errors: [], unverified: null });
    expect(parse("S4VT00033").totals).toMatchObject({ office: "S", electionYear: 2030, receipts: 26324335.09 });
  });

  it("leaves out, with the reason, a record whose lines don't add up to its totals", () => {
    // As H8NJ02166's did on 2026-10-18: individual contributions $1,000 off the sum of their lines.
    const off = parse("H8CA05035", withField("H8CA05035", "individual_unitemized_contributions", 1411000));
    expect(off).toMatchObject({ totals: null, errors: [] });
    expect(off.unverified).toMatch(/^individual contributions .* don't equal/);
    expect(parse("H8CA05035", withField("H8CA05035", "other_receipts", 50000)).unverified).toMatch(/total receipts/);
    expect(parse("H8CA05035", withField("H8CA05035", "other_disbursements", 0)).unverified).toMatch(/total disbursements/);
    expect(parse("H8CA05035", withField("H8CA05035", "loans_made_by_candidate", 5000)).unverified).toMatch(/loans/);
  });

  it("leaves out, with the reason, a record that disagrees with the batch totals", () => {
    const row = { ...batchRow("H8CA05035")!, receipts: 2467000 };
    const r = parse("H8CA05035", undefined, row);
    expect(r).toMatchObject({ totals: null, errors: [] });
    expect(r.unverified).toMatch(/receipts is \$2,467,978.64 in the candidate record but \$2,467,000.00/);
    const late = { ...batchRow("H8CA05035")!, coverageEnd: "2026-06-30" };
    expect(parse("H8CA05035", undefined, late).unverified).toMatch(/coverage ends 2026-09-30 .* but 2026-06-30/);
    expect(parseCandidateTotals(fixture("candidate-H8CA05035.json"), "H8CA05035", 2026, undefined, meta("H8CA05035"), today).errors.join()).toMatch(/not in the candidates\/totals results/);
  });

  it("accepts lines that net below zero over the cycle, as long as they still add up", () => {
    // As H2WA03217's debts and H6PA16320's refunds did on 2026-10-18.
    expect(parse("H8CA05035", withField("H8CA05035", "last_debts_owed_by_committee", -2500))).toMatchObject({ errors: [], unverified: null, totals: { debts: -2500 } });
    const [r] = fixture("candidate-H8CA05035.json").results as Record<string, unknown>[];
    const body = { ...fixture("candidate-H8CA05035.json"), results: [{ ...r, contribution_refunds: -500, other_disbursements: Number(r.other_disbursements) + Number(r.contribution_refunds) + 500 }] };
    expect(parse("H8CA05035", body)).toMatchObject({ errors: [], unverified: null });
  });

  it("accepts a first report that starts after the previous cycle's post-general report", () => {
    // As H6FL06258's and H6FL01390's did on 2026-10-18 (coverage from 2024-11-26 and 2024-12-03).
    expect(parse("H8CA05035", withField("H8CA05035", "coverage_start_date", "2024-11-26T00:00:00"))).toMatchObject({ errors: [], unverified: null, totals: { coverageStart: "2024-11-26" } });
    expect(parse("H8CA05035", withField("H8CA05035", "coverage_start_date", "2023-07-01T00:00:00")).errors.join()).toMatch(/outside the 2025–2026 cycle/);
    const [r] = fixture("candidate-H8CA05035.json").results as Record<string, unknown>[];
    const before = { ...fixture("candidate-H8CA05035.json"), results: [{ ...r, coverage_start_date: "2024-11-26T00:00:00", coverage_end_date: "2024-12-31T00:00:00" }] };
    expect(parse("H8CA05035", before).errors.join()).toMatch(/outside the 2025–2026 cycle/);
  });

  it("rejects the wrong candidate, the wrong cycle, whole-election totals, and missing figures", () => {
    expect(parse("S6MN00267", fixture("candidate-H8CA05035.json")).errors.join()).toMatch(/record is for H8CA05035/);
    expect(parse("H8CA05035", withField("H8CA05035", "cycle", 2024)).errors.join()).toMatch(/cycle 2024/);
    expect(parse("H8CA05035", withField("H8CA05035", "election_full", true)).errors.join()).toMatch(/whole election/);
    expect(parse("H8CA05035", withField("H8CA05035", "receipts", null)).errors.join()).toMatch(/receipts is missing/);
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
    expect(toMemberFinance({ chamber: "house" }, ["S4VT00033", "H8CA05035"], [senate, house], fetchedAt).campaigns.map((c) => c.office)).toEqual(["H", "S"]);
    expect(toMemberFinance({ chamber: "senate" }, ["H8CA05035", "S4VT00033"], [house, senate], fetchedAt).campaigns.map((c) => c.office)).toEqual(["S", "H"]);
  });
});

describe("memberFinanceStatus", () => {
  const house = () => parse("H8CA05035").totals!;
  const senate = () => parse("S4VT00033").totals!;

  it("only says a member filed nothing when the last pull covered them", () => {
    const m = { chamber: "house" as const, fecIds: ["H8CA05035"] };
    expect(memberFinanceStatus(m, { candidateIds: ["H8CA05035"], campaigns: [], fetchedAt })).toEqual({ status: "ok", campaigns: [] });
    expect(memberFinanceStatus(m, undefined)).toEqual({ status: "not-covered", campaigns: [] });
  });

  it("treats a member linked to an id the pull didn't ask about as not covered", () => {
    const m = { chamber: "senate" as const, fecIds: ["H8CA05035", "S9CA00001"] };
    expect(memberFinanceStatus(m, { candidateIds: ["H8CA05035"], campaigns: [house()], fetchedAt })).toEqual({ status: "not-covered", campaigns: [] });
  });

  it("leaves out campaigns for ids the roster no longer links to the member", () => {
    const m = { chamber: "house" as const, fecIds: ["H8CA05035"] };
    const entry = { candidateIds: ["H8CA05035", "S4VT00033"], campaigns: [house(), senate()], fetchedAt };
    expect(memberFinanceStatus(m, entry).campaigns.map((c) => c.candidateId)).toEqual(["H8CA05035"]);
  });

  it("tells apart a member with no House or Senate FEC id", () => {
    expect(memberFinanceStatus({ chamber: "house", fecIds: [] }, undefined).status).toBe("no-ids");
    expect(memberFinanceStatus({ chamber: "senate", fecIds: ["P60007168"] }, undefined).status).toBe("no-ids");
  });

  it("shows nothing for a member whose seat's campaign was left out, and drops another left-out campaign", () => {
    const m = { chamber: "house" as const, fecIds: ["H8CA05035", "S4VT00033"] };
    const entry = { candidateIds: ["H8CA05035", "S4VT00033"], campaigns: [house(), senate()], fetchedAt };
    // Supabase may still hold an earlier pull's row for a campaign left out since, so it's in `campaigns` here.
    expect(memberFinanceStatus(m, entry, { H8CA05035: "off" })).toEqual({ status: "unverified", campaigns: [], unverified: "off" });
    expect(memberFinanceStatus(m, entry, { S4VT00033: "off" })).toEqual({ status: "ok", campaigns: [house()] });
  });

  it("puts the seat's campaign first", () => {
    const r = memberFinanceStatus({ chamber: "senate", fecIds: ["H8CA05035", "S4VT00033"] }, { candidateIds: ["H8CA05035", "S4VT00033"], campaigns: [house(), senate()], fetchedAt });
    expect(r.campaigns.map((c) => c.candidateId)).toEqual(["S4VT00033", "H8CA05035"]);
  });
});

describe("campaignFromRow", () => {
  it("reads a Supabase row, whose numeric columns arrive as strings, back to the same campaign", () => {
    const c = parse("H8CA05035").totals!;
    const row: Record<string, unknown> = {
      candidate_id: c.candidateId, cycle: c.cycle, bioguide_id: "P000197", office: c.office, election_year: c.electionYear,
      coverage_start: c.coverageStart, coverage_end: c.coverageEnd, last_report: c.lastReport,
      receipts: "2467978.64", disbursements: "4161736.27", cash_on_hand: "384308.83", debts: "0.00",
      individual_itemized: "808796.43", individual_unitemized: "1411326.97", party_committees: "0.00", other_committees: "33000.00",
      candidate_contributions: "0.00", candidate_loans: "0.00", other_loans: "0.00", transfers_in: "141138.40", other_receipts: "73716.84",
      page_url: c.pageUrl, source_url: c.sourceUrl, sha256: c.sha256, fetched_at: c.fetchedAt,
    };
    expect(campaignFromRow(row)).toEqual(c);
    expect(() => campaignFromRow({ ...row, receipts: null })).toThrow(/receipts is not a number/);
  });
});

describe("validateFinanceSnapshot", () => {
  const build = (): FinanceSnapshot => {
    const t = (id: string) => parse(id).totals!;
    return {
      provenance: { source: "the FEC", sourceHome: "https://www.fec.gov/data/", fetchedAt, cycle: 2026 },
      sources: [{ url: candidatesTotalsUrl(asked, 2026), sha256: "b".repeat(64) }],
      members: {
        P000197: toMemberFinance({ chamber: "house" }, ["H8CA05035"], [t("H8CA05035")], fetchedAt),
        K000367: toMemberFinance({ chamber: "senate" }, ["S6MN00267"], [t("S6MN00267")], fetchedAt),
        S000033: toMemberFinance({ chamber: "senate" }, ["S4VT00033"], [t("S4VT00033")], fetchedAt),
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

  it("rejects a campaign for an id that wasn't asked about", () => {
    const snap = build();
    snap.members.P000197.candidateIds = [];
    expect(validateFinanceSnapshot(snap, ids, null).join()).toMatch(/P000197: H8CA05035 wasn't one of the ids asked about/);
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

  it("rejects a campaign that had reports at the last pull and has none now, unless its member left", () => {
    const prev = build();
    const snap = build();
    snap.members.K000367.campaigns = [];
    expect(validateFinanceSnapshot(snap, ids, prev).join()).toMatch(/K000367: S6MN00267 had 2025–2026 reports at the last pull but none now/);
    delete snap.members.K000367;
    expect(validateFinanceSnapshot(snap, ["P000197", "S000033"], prev)).toEqual([]);
  });

  it("lets go of a campaign once the roster unlinks its id from a sitting member", () => {
    const prev = build();
    const snap = build();
    snap.members.K000367 = toMemberFinance({ chamber: "senate" }, ["S8MN00999"], [], fetchedAt);
    expect(validateFinanceSnapshot(snap, ids, prev).join()).not.toMatch(/S6MN00267/);
  });

  it("accepts a few campaigns left out with a reason, but not too many, nor one also published", () => {
    const snap = build();
    snap.members.V000133 = toMemberFinance({ chamber: "house" }, ["H8NJ02166"], [], fetchedAt);
    snap.unverified = { H8NJ02166: "individual contributions $1,870,731.43 don't equal the sum of their lines, $1,871,731.43" };
    expect(validateFinanceSnapshot(snap, [...ids, "V000133"], null)).toEqual([]);

    snap.unverified.H8NJ02166 = " ";
    expect(validateFinanceSnapshot(snap, [...ids, "V000133"], null).join()).toMatch(/H8NJ02166 is left out with no reason/);
    snap.unverified = { H8CA05035: "off" };
    expect(validateFinanceSnapshot(snap, [...ids, "V000133"], null).join()).toMatch(/P000197: H8CA05035 is both published and left out/);
    snap.unverified = { H9XX00001: "off" };
    expect(validateFinanceSnapshot(snap, [...ids, "V000133"], null).join()).toMatch(/H9XX00001 is left out but wasn't one of the ids asked about/);

    const many = build();
    const extra = ["H1AA00001", "H1AA00002", "H1AA00003", "H1AA00004", "H1AA00005", "H1AA00006"];
    many.members.X000001 = toMemberFinance({ chamber: "house" }, extra, [], fetchedAt);
    many.unverified = Object.fromEntries(extra.map((id) => [id, "off"]));
    expect(validateFinanceSnapshot(many, ids, null).join()).toMatch(/6 campaigns left out .* \(more than 5\)/);
  });

  it("doesn't count a campaign left out now as one whose reports disappeared", () => {
    const prev = build();
    const snap = build();
    snap.members.K000367.campaigns = [];
    snap.unverified = { S6MN00267: "off" };
    expect(validateFinanceSnapshot(snap, ids, prev).join()).not.toMatch(/S6MN00267/);
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

describe("financeFingerprint", () => {
  it("changes when a member's candidate ids change, even if no campaign did", () => {
    const c = parse("H8CA05035").totals!;
    const snap = (ids: string[]): FinanceSnapshot => ({
      provenance: { source: "the FEC", sourceHome: "https://www.fec.gov/data/", fetchedAt, cycle: 2026 },
      sources: [],
      members: { P000197: toMemberFinance({ chamber: "house" }, ids, [c], fetchedAt) },
    });
    expect(financeFingerprint(snap(["H8CA05035"]))).toBe(financeFingerprint(snap(["H8CA05035"])));
    expect(financeFingerprint(snap(["H8CA05035", "S8CA00001"]))).not.toBe(financeFingerprint(snap(["H8CA05035"])));
    expect(financeFingerprint({ ...snap(["H8CA05035", "S8CA00001"]), unverified: { S8CA00001: "off" } })).not.toBe(financeFingerprint(snap(["H8CA05035", "S8CA00001"])));
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
