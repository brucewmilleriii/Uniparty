import type { CampaignTotals, FinanceSnapshot, Member, MemberFinance } from "@/lib/types";

/*
 * Parse and validate each member's campaign committee totals from the FEC API.
 * Pure functions only: fetching and writing live in scripts/ingest-finance.ts.
 *
 * The figures are the FEC's own roll-up of the reports the candidate's authorized
 * committees filed (Form 3), for one two-year cycle. Every record is checked
 * against the report's line arithmetic and against a second FEC endpoint.
 */

export const FINANCE_SOURCE = { source: "the FEC", sourceHome: "https://www.fec.gov/data/" } as const;

export const API_BASE = "https://api.open.fec.gov/v1";

/** Candidate ids asked for in one /candidates/totals/ request. */
export const BATCH_SIZE = 100;

/** Share of members with FEC ids who must have reports in the cycle, or the source looks partial. */
export const MIN_COVERAGE = 0.8;

/** Largest rounding gap, in dollars, allowed between figures that should be equal. */
const TOLERANCE = 1;

/** The batch endpoint: which of these candidates have totals in the cycle. The key goes in a header, never in a stored URL. */
export const candidatesTotalsUrl = (ids: string[], cycle: number, base = API_BASE) =>
  `${base}/candidates/totals/?${ids.map((id) => `candidate_id=${id}`).join("&")}&cycle=${cycle}&election_full=false&per_page=${BATCH_SIZE}`;
/** One candidate's full breakdown for the cycle. */
export const candidateTotalsUrl = (id: string, cycle: number, base = API_BASE) =>
  `${base}/candidate/${id}/totals/?cycle=${cycle}&election_full=false`;
/** The candidate's page on fec.gov for the same two-year period. */
export const fecPageUrl = (id: string, cycle: number) => `https://www.fec.gov/data/candidate/${id}/?cycle=${cycle}&election_full=false`;

/** Congressional campaigns only; presidential committees file a different form with different arithmetic. */
export const isCongressionalId = (id: string) => /^[HS]\d[A-Z]{2}\d{5}$/.test(id);

/**
 * The two-year cycle to show. Cycles end in even years. Early in an odd year the new
 * cycle has no reports yet (the first, the April quarterly, is due April 15), so until
 * May the cycle that just ended is still the latest complete picture.
 */
export function fecCycle(today: Date): number {
  const y = today.getUTCFullYear();
  if (y % 2 === 0) return y;
  return today.getUTCMonth() >= 4 ? y + 1 : y - 1;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
/** The FEC returns some amounts as numbers and some as strings ("384308.83"). */
const amount = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
const cents = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Read a page of results; it must be complete in one page, since every request is sized to fit. */
function readResults(body: unknown, what: string): Obj[] {
  if (!isObj(body) || !Array.isArray(body.results) || !isObj(body.pagination)) throw new Error(`Not an FEC ${what} response`);
  const { count, pages } = body.pagination;
  const results = body.results.filter(isObj);
  if (typeof count !== "number" || count !== results.length || (typeof pages === "number" && pages > 1))
    throw new Error(`FEC ${what} response is incomplete: ${results.length} results of ${String(count)}`);
  return results;
}

/** The batch figures, kept only to cross-check the detailed record. */
export interface BatchRow {
  candidateId: string;
  receipts: number;
  disbursements: number;
  cashOnHand: number;
  individualItemized: number;
  otherCommittees: number;
  transfersIn: number;
  coverageEnd: string;
}

/**
 * Read /candidates/totals/: every row must be one of the candidates asked for, in the cycle, at most once.
 * Only candidates with reports in the cycle are returned.
 */
export function readBatch(body: unknown, asked: string[], cycle: number): { rows: BatchRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: BatchRow[] = [];
  const want = new Set(asked);
  const seen = new Set<string>();
  for (const r of readResults(body, "candidates/totals")) {
    const id = str(r.candidate_id);
    if (!want.has(id)) {
      errors.push(`candidates/totals returned ${id || "a row with no candidate id"}, which wasn't asked for`);
      continue;
    }
    if (seen.has(id)) errors.push(`candidates/totals lists ${id} twice`);
    seen.add(id);
    if (Number(r.cycle) !== cycle) errors.push(`candidates/totals row for ${id} is for cycle ${String(r.cycle)}, not ${cycle}`);
    // Old candidate ids (a member's earlier House run, say) come back as a placeholder row with
    // no coverage dates and nothing filed; those campaigns have no reports this cycle.
    const money = [r.receipts, r.disbursements, r.cash_on_hand_end_period].map(amount);
    if (r.coverage_end_date === null) {
      if (money.some((m) => m !== 0)) errors.push(`candidates/totals row for ${id} has money but no coverage dates`);
      continue;
    }
    rows.push({
      candidateId: id,
      receipts: amount(r.receipts),
      disbursements: amount(r.disbursements),
      cashOnHand: amount(r.cash_on_hand_end_period),
      individualItemized: amount(r.individual_itemized_contributions),
      otherCommittees: amount(r.other_political_committee_contributions),
      transfersIn: amount(r.transfers_from_other_authorized_committee),
      coverageEnd: str(r.coverage_end_date).slice(0, 10),
    });
  }
  return { rows, errors };
}

/**
 * Read one candidate's /candidate/{id}/totals/ record for the cycle and check it:
 * every figure present and readable, the report's sub-totals adding up to its totals,
 * and the headline figures matching what the batch endpoint reported.
 */
export function parseCandidateTotals(
  body: unknown,
  candidateId: string,
  cycle: number,
  batch: BatchRow | undefined,
  meta: { sourceUrl: string; sha256: string; fetchedAt: string },
  today = new Date(),
): { totals: CampaignTotals | null; errors: string[] } {
  const at = `${candidateId} ${cycle}`;
  const rows = readResults(body, `candidate/${candidateId}/totals`);
  if (rows.length !== 1) return { totals: null, errors: [`${at}: expected one totals record, got ${rows.length}`] };
  const r = rows[0];
  const errors: string[] = [];
  if (str(r.candidate_id) !== candidateId) errors.push(`${at}: record is for ${str(r.candidate_id) || "no candidate"}`);
  if (Number(r.cycle) !== cycle) errors.push(`${at}: record is for cycle ${String(r.cycle)}`);
  if (r.election_full !== false) errors.push(`${at}: record covers the whole election, not the two-year cycle`);

  const fields = {
    receipts: "receipts",
    disbursements: "disbursements",
    cashOnHand: "last_cash_on_hand_end_period",
    debts: "last_debts_owed_by_committee",
    contributions: "contributions",
    individual: "individual_contributions",
    individualItemized: "individual_itemized_contributions",
    individualUnitemized: "individual_unitemized_contributions",
    partyCommittees: "political_party_committee_contributions",
    otherCommittees: "other_political_committee_contributions",
    candidateContributions: "candidate_contribution",
    loans: "loans",
    candidateLoans: "loans_made_by_candidate",
    otherLoans: "all_other_loans",
    transfersIn: "transfers_from_other_authorized_committee",
    otherReceipts: "other_receipts",
    offsets: "offsets_to_operating_expenditures",
    federalFunds: "federal_funds",
    operating: "operating_expenditures",
    transfersOut: "transfers_to_other_authorized_committee",
    loanRepayments: "loan_repayments",
    refunds: "contribution_refunds",
    otherDisbursements: "other_disbursements",
  } as const;
  const n = {} as Record<keyof typeof fields, number>;
  for (const [k, f] of Object.entries(fields) as [keyof typeof fields, string][]) {
    n[k] = amount(r[f]);
    if (!Number.isFinite(n[k])) errors.push(`${at}: ${f} is missing or unreadable (${JSON.stringify(r[f])})`);
    else if (n[k] < 0 && k !== "cashOnHand") errors.push(`${at}: ${f} is negative (${n[k]})`);
  }

  const start = str(r.coverage_start_date).slice(0, 10);
  const end = str(r.coverage_end_date).slice(0, 10);
  if (!isDate(start) || !isDate(end) || start > end) errors.push(`${at}: unreadable coverage dates ${start} to ${end}`);
  else {
    if (Number(start.slice(0, 4)) < cycle - 1 || Number(end.slice(0, 4)) > cycle) errors.push(`${at}: coverage ${start} to ${end} falls outside the ${cycle - 1}–${cycle} cycle`);
    if (Date.parse(end) > today.getTime() + 86_400_000) errors.push(`${at}: coverage ends in the future (${end})`);
  }
  if (errors.length) return { totals: null, errors };

  // Form 3's own arithmetic: line 11(a)(iii), 11(e), 13(c), 16 and 22.
  const sums: [string, number, number][] = [
    ["individual contributions", n.individual, n.individualItemized + n.individualUnitemized],
    ["total contributions", n.contributions, n.individual + n.partyCommittees + n.otherCommittees + n.candidateContributions],
    ["loans", n.loans, n.candidateLoans + n.otherLoans],
    ["total receipts", n.receipts, n.contributions + n.loans + n.transfersIn + n.otherReceipts + n.offsets + n.federalFunds],
    ["total disbursements", n.disbursements, n.operating + n.transfersOut + n.loanRepayments + n.refunds + n.otherDisbursements],
  ];
  for (const [what, total, parts] of sums)
    if (Math.abs(total - parts) > TOLERANCE) errors.push(`${at}: ${what} ${usd(total)} don't equal the sum of their lines, ${usd(parts)}`);

  if (!batch) errors.push(`${at}: not in the candidates/totals results`);
  else {
    const pairs: [string, number, number][] = [
      ["receipts", n.receipts, batch.receipts],
      ["disbursements", n.disbursements, batch.disbursements],
      ["cash on hand", n.cashOnHand, batch.cashOnHand],
      ["itemized individual contributions", n.individualItemized, batch.individualItemized],
      ["PAC and other committee contributions", n.otherCommittees, batch.otherCommittees],
      ["transfers in", n.transfersIn, batch.transfersIn],
    ];
    for (const [what, detail, summary] of pairs)
      if (!Number.isFinite(summary) || Math.abs(detail - summary) > TOLERANCE) errors.push(`${at}: ${what} is ${usd(detail)} in the candidate record but ${usd(summary)} in candidates/totals`);
    if (batch.coverageEnd !== end) errors.push(`${at}: coverage ends ${end} in the candidate record but ${batch.coverageEnd} in candidates/totals`);
  }
  if (errors.length) return { totals: null, errors };

  const reportType = str(r.last_report_type_full);
  const reportYear = Number(r.last_report_year);
  return {
    errors,
    totals: {
      candidateId,
      office: candidateId[0] === "S" ? "S" : "H",
      electionYear: Number(r.candidate_election_year) || null,
      cycle,
      coverageStart: start,
      coverageEnd: end,
      lastReport: reportType ? `${reportType}${Number.isInteger(reportYear) && reportYear > 0 ? ` ${reportYear}` : ""}` : null,
      receipts: cents(n.receipts),
      disbursements: cents(n.disbursements),
      cashOnHand: cents(n.cashOnHand),
      debts: cents(n.debts),
      individualItemized: cents(n.individualItemized),
      individualUnitemized: cents(n.individualUnitemized),
      partyCommittees: cents(n.partyCommittees),
      otherCommittees: cents(n.otherCommittees),
      candidateContributions: cents(n.candidateContributions),
      candidateLoans: cents(n.candidateLoans),
      otherLoans: cents(n.otherLoans),
      transfersIn: cents(n.transfersIn),
      otherReceipts: cents(n.otherReceipts + n.offsets + n.federalFunds),
      pageUrl: fecPageUrl(candidateId, cycle),
      sourceUrl: meta.sourceUrl,
      sha256: meta.sha256,
      fetchedAt: meta.fetchedAt,
    },
  };
}

/** Where a campaign's money came from, in display order. The parts add up to its receipts. */
export function receiptParts(c: CampaignTotals): { key: string; label: string; amount: number }[] {
  return [
    { key: "unitemized", label: "Small donors ($200 or less)", amount: c.individualUnitemized },
    { key: "itemized", label: "Larger individual donors", amount: c.individualItemized },
    { key: "pac", label: "PACs and other committees", amount: c.otherCommittees },
    { key: "party", label: "Party committees", amount: c.partyCommittees },
    { key: "self", label: "The candidate", amount: cents(c.candidateContributions + c.candidateLoans) },
    { key: "loans", label: "Other loans", amount: c.otherLoans },
    { key: "transfers", label: "Transfers from other campaign committees", amount: c.transfersIn },
    { key: "other", label: "Other receipts", amount: c.otherReceipts },
  ];
}

/** A member's campaigns, the one for the seat they hold first, then by money raised. */
export function toMemberFinance(m: Pick<Member, "chamber">, campaigns: CampaignTotals[], fetchedAt: string): MemberFinance {
  const seat = m.chamber === "senate" ? "S" : "H";
  return {
    campaigns: [...campaigns].sort((a, b) => Number(b.office === seat) - Number(a.office === seat) || b.receipts - a.receipts),
    fetchedAt,
  };
}

/**
 * Whole-snapshot checks run before writing: enough members have reports to rule out
 * a partial source, every record is traceable, no candidate is credited to two members,
 * and no committee's reports went backwards in time since the last good pull.
 */
export function validateFinanceSnapshot(snap: FinanceSnapshot, membersWithIds: string[], previous: FinanceSnapshot | null): string[] {
  const errors: string[] = [];
  const { cycle } = snap.provenance;
  const covered = membersWithIds.filter((id) => snap.members[id]?.campaigns.length).length;
  if (membersWithIds.length && covered / membersWithIds.length < MIN_COVERAGE)
    errors.push(`Only ${covered} of ${membersWithIds.length} members have ${cycle - 1}–${cycle} reports; source looks partial`);

  if (snap.sources.some((s) => !/^[0-9a-f]{64}$/.test(s.sha256) || !s.url.startsWith(API_BASE))) errors.push("A batch source has no hash or URL");
  const owner = new Map<string, string>();
  const prevEnd = new Map<string, string>();
  if (previous?.provenance.cycle === cycle) for (const m of Object.values(previous.members)) for (const c of m.campaigns) prevEnd.set(c.candidateId, c.coverageEnd);

  for (const [id, m] of Object.entries(snap.members)) {
    for (const c of m.campaigns) {
      if (c.cycle !== cycle) errors.push(`${id}: ${c.candidateId} is for cycle ${c.cycle}, not ${cycle}`);
      if (!/^[0-9a-f]{64}$/.test(c.sha256) || !c.sourceUrl.startsWith(API_BASE) || !c.pageUrl.startsWith("https://www.fec.gov/"))
        errors.push(`${id}: ${c.candidateId} has no source hash or URL`);
      const other = owner.get(c.candidateId);
      if (other) errors.push(`${c.candidateId} is credited to both ${other} and ${id}`);
      owner.set(c.candidateId, id);
      const before = prevEnd.get(c.candidateId);
      if (before && c.coverageEnd < before) errors.push(`${id}: ${c.candidateId} reports now end ${c.coverageEnd}, earlier than ${before} at the last pull`);
    }
  }
  const urls = [...snap.sources.map((s) => s.url), ...Object.values(snap.members).flatMap((m) => m.campaigns.map((c) => c.sourceUrl))];
  if (urls.some((u) => /api_key/i.test(u))) errors.push("An API key is in a stored URL");
  return errors;
}
