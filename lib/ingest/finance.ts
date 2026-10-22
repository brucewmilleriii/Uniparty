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

/**
 * Campaigns whose FEC figures don't add up may be left out (see FinanceSnapshot.unverified),
 * but more than this many in one run means something is wrong with the pull, not the filings.
 */
export const MAX_UNVERIFIED_CAMPAIGNS = 5;

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
 * The two-year cycle to show. Cycles end in even years. In an odd year the new cycle fills in
 * slowly: House campaigns first report for it on April 15, but Senate campaigns not up at the
 * next election file semiannually, so about two thirds of senators first report on July 31.
 * Until mid-August, when those are in, the cycle that just ended is the latest complete picture
 * for everyone, and it stays labelled with its own cycle and coverage dates.
 */
export function fecCycle(today: Date): number {
  const y = today.getUTCFullYear();
  if (y % 2 === 0) return y;
  return today.getTime() >= Date.UTC(y, 7, 15) ? y + 1 : y - 1;
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
 *
 * A record that is the wrong shape, or for the wrong candidate or cycle, is an error. A
 * well-formed record whose figures don't add up, or disagree with the batch totals, is the
 * FEC's own data not adding up; it comes back as `unverified`, the reason it can't be shown.
 *
 * Line items can be negative. The FEC sums every report in the cycle, and a committee that
 * refunds, reverses or corrects an earlier entry reports it as a negative amount, so a line
 * can net below zero over the cycle.
 */
export function parseCandidateTotals(
  body: unknown,
  candidateId: string,
  cycle: number,
  batch: BatchRow | undefined,
  meta: { sourceUrl: string; sha256: string; fetchedAt: string },
  today = new Date(),
): { totals: CampaignTotals | null; errors: string[]; unverified: string | null } {
  const at = `${candidateId} ${cycle}`;
  const rows = readResults(body, `candidate/${candidateId}/totals`);
  if (rows.length !== 1) return { totals: null, errors: [`${at}: expected one totals record, got ${rows.length}`], unverified: null };
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
  }

  const start = str(r.coverage_start_date).slice(0, 10);
  const end = str(r.coverage_end_date).slice(0, 10);
  if (!isDate(start) || !isDate(end) || start > end) errors.push(`${at}: unreadable coverage dates ${start} to ${end}`);
  else {
    // A report counts toward the cycle its coverage ends in. The first one can start late in the
    // year before: the post-general report closes in late November, and the next begins the day after.
    if (Number(start.slice(0, 4)) < cycle - 2 || Number(end.slice(0, 4)) < cycle - 1 || Number(end.slice(0, 4)) > cycle) errors.push(`${at}: coverage ${start} to ${end} falls outside the ${cycle - 1}–${cycle} cycle`);
    if (Date.parse(end) > today.getTime() + 86_400_000) errors.push(`${at}: coverage ends in the future (${end})`);
  }
  if (errors.length) return { totals: null, errors, unverified: null };
  if (!batch) return { totals: null, errors: [`${at}: not in the candidates/totals results`], unverified: null };

  const mismatches: string[] = [];
  // Form 3's own arithmetic: line 11(a)(iii), 11(e), 13(c), 16 and 22.
  const sums: [string, number, number][] = [
    ["individual contributions", n.individual, n.individualItemized + n.individualUnitemized],
    ["total contributions", n.contributions, n.individual + n.partyCommittees + n.otherCommittees + n.candidateContributions],
    ["loans", n.loans, n.candidateLoans + n.otherLoans],
    ["total receipts", n.receipts, n.contributions + n.loans + n.transfersIn + n.otherReceipts + n.offsets + n.federalFunds],
    ["total disbursements", n.disbursements, n.operating + n.transfersOut + n.loanRepayments + n.refunds + n.otherDisbursements],
  ];
  for (const [what, total, parts] of sums)
    if (Math.abs(total - parts) > TOLERANCE) mismatches.push(`${what} ${usd(total)} don't equal the sum of their lines, ${usd(parts)}`);

  const pairs: [string, number, number][] = [
    ["receipts", n.receipts, batch.receipts],
    ["disbursements", n.disbursements, batch.disbursements],
    ["cash on hand", n.cashOnHand, batch.cashOnHand],
    ["itemized individual contributions", n.individualItemized, batch.individualItemized],
    ["PAC and other committee contributions", n.otherCommittees, batch.otherCommittees],
    ["transfers in", n.transfersIn, batch.transfersIn],
  ];
  for (const [what, detail, summary] of pairs)
    if (!Number.isFinite(summary) || Math.abs(detail - summary) > TOLERANCE) mismatches.push(`${what} is ${usd(detail)} in the candidate record but ${usd(summary)} in candidates/totals`);
  if (batch.coverageEnd !== end) mismatches.push(`coverage ends ${end} in the candidate record but ${batch.coverageEnd} in candidates/totals`);
  if (mismatches.length) return { totals: null, errors, unverified: mismatches.join("; ") };

  const reportType = str(r.last_report_type_full);
  const reportYear = Number(r.last_report_year);
  return {
    errors,
    unverified: null,
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
export function toMemberFinance(m: Pick<Member, "chamber">, candidateIds: string[], campaigns: CampaignTotals[], fetchedAt: string): MemberFinance {
  const seat = m.chamber === "senate" ? "S" : "H";
  return {
    candidateIds,
    campaigns: [...campaigns].sort((a, b) => Number(b.office === seat) - Number(a.office === seat) || b.receipts - a.receipts),
    fetchedAt,
  };
}

/**
 * What a snapshot says, for deciding whether a run changed anything: each member's
 * candidate ids (the page relies on them to know what was asked) and campaign hashes.
 */
export const financeFingerprint = (s: FinanceSnapshot) =>
  `${s.provenance.cycle}:${Object.entries(s.members)
    .map(([id, m]) => `${id}[${m.candidateIds.join(",")}]=${m.campaigns.map((c) => c.sha256).join("+")}`)
    .join()}|left out:${Object.keys(s.unverified ?? {}).sort().join()}`;

export type MemberFinanceStatus = "ok" | "no-ids" | "not-covered" | "unverified";

/**
 * What can be said about a member's money, given the last pull's entry for them (undefined
 * when the pull didn't include them). Only a member whose every current candidate id the pull
 * asked about can be said to have filed nothing, and only campaigns for their current ids are shown.
 * A campaign the pull left out because its FEC figures didn't add up (`unverified`, keyed by
 * candidate id) is never shown; when it is the campaign for the member's seat, nothing is shown
 * in its place, so another campaign isn't mistaken for it.
 */
export function memberFinanceStatus(
  m: Pick<Member, "chamber" | "fecIds">,
  entry: MemberFinance | undefined,
  unverified: Record<string, string> = {},
): { status: MemberFinanceStatus; campaigns: CampaignTotals[]; unverified?: string } {
  const ids = m.fecIds.filter(isCongressionalId);
  if (!ids.length) return { status: "no-ids", campaigns: [] };
  if (!entry || ids.some((id) => !entry.candidateIds.includes(id))) return { status: "not-covered", campaigns: [] };
  const seat = m.chamber === "senate" ? "S" : "H";
  const seatUnverified = ids.find((id) => id[0] === seat && unverified[id]);
  if (seatUnverified) return { status: "unverified", campaigns: [], unverified: unverified[seatUnverified] };
  const current = entry.campaigns.filter((c) => ids.includes(c.candidateId) && !unverified[c.candidateId]);
  return { status: "ok", campaigns: toMemberFinance(m, ids, current, entry.fetchedAt).campaigns };
}

/** A campaign_totals row from Supabase, where numeric columns arrive as strings. */
export function campaignFromRow(r: Record<string, unknown>): CampaignTotals {
  const n = (k: string) => {
    const v = r[k] === null || r[k] === "" ? NaN : Number(r[k]);
    if (!Number.isFinite(v)) throw new Error(`campaign_totals ${String(r.candidate_id)}: ${k} is not a number (${JSON.stringify(r[k])})`);
    return v;
  };
  return {
    candidateId: String(r.candidate_id),
    office: r.office === "S" ? "S" : "H",
    electionYear: r.election_year === null ? null : n("election_year"),
    cycle: n("cycle"),
    coverageStart: String(r.coverage_start),
    coverageEnd: String(r.coverage_end),
    lastReport: (r.last_report as string | null) ?? null,
    receipts: n("receipts"),
    disbursements: n("disbursements"),
    cashOnHand: n("cash_on_hand"),
    debts: n("debts"),
    individualItemized: n("individual_itemized"),
    individualUnitemized: n("individual_unitemized"),
    partyCommittees: n("party_committees"),
    otherCommittees: n("other_committees"),
    candidateContributions: n("candidate_contributions"),
    candidateLoans: n("candidate_loans"),
    otherLoans: n("other_loans"),
    transfersIn: n("transfers_in"),
    otherReceipts: n("other_receipts"),
    pageUrl: String(r.page_url),
    sourceUrl: String(r.source_url),
    sha256: String(r.sha256),
    fetchedAt: String(r.fetched_at),
  };
}

/**
 * Whole-snapshot checks run before writing: enough members have reports to rule out
 * a partial source, every record is traceable, no candidate is credited to two members,
 * and no campaign's reports went backwards or disappeared since the last good pull.
 */
export function validateFinanceSnapshot(snap: FinanceSnapshot, membersWithIds: string[], previous: FinanceSnapshot | null): string[] {
  const errors: string[] = [];
  const { cycle } = snap.provenance;
  const unverified = snap.unverified ?? {};
  // A member whose campaign was left out did file reports; the FEC's figures just didn't add up.
  const covered = membersWithIds.filter((id) => snap.members[id]?.campaigns.length || snap.members[id]?.candidateIds.some((c) => unverified[c])).length;
  if (membersWithIds.length && covered / membersWithIds.length < MIN_COVERAGE)
    errors.push(`Only ${covered} of ${membersWithIds.length} members have ${cycle - 1}–${cycle} reports; source looks partial`);

  if (snap.sources.some((s) => !/^[0-9a-f]{64}$/.test(s.sha256) || !s.url.startsWith(API_BASE))) errors.push("A batch source has no hash or URL");
  const left = Object.keys(unverified);
  if (left.length > MAX_UNVERIFIED_CAMPAIGNS)
    errors.push(`${left.length} campaigns left out because their FEC figures don't add up (more than ${MAX_UNVERIFIED_CAMPAIGNS}): ${left.join(", ")}`);
  const asked = new Set(Object.values(snap.members).flatMap((m) => m.candidateIds));
  for (const id of left) {
    if (!unverified[id].trim()) errors.push(`${id} is left out with no reason`);
    if (!asked.has(id)) errors.push(`${id} is left out but wasn't one of the ids asked about`);
  }

  const owner = new Map<string, string>();
  // Within one cycle a campaign's reports only accumulate, so compare with the last good pull.
  const prevEnd = new Map<string, { member: string; end: string }>();
  if (previous?.provenance.cycle === cycle)
    for (const [id, m] of Object.entries(previous.members)) for (const c of m.campaigns) prevEnd.set(c.candidateId, { member: id, end: c.coverageEnd });

  for (const [id, m] of Object.entries(snap.members)) {
    for (const c of m.campaigns) {
      if (c.cycle !== cycle) errors.push(`${id}: ${c.candidateId} is for cycle ${c.cycle}, not ${cycle}`);
      if (!m.candidateIds.includes(c.candidateId)) errors.push(`${id}: ${c.candidateId} wasn't one of the ids asked about`);
      if (!/^[0-9a-f]{64}$/.test(c.sha256) || !c.sourceUrl.startsWith(API_BASE) || !c.pageUrl.startsWith("https://www.fec.gov/"))
        errors.push(`${id}: ${c.candidateId} has no source hash or URL`);
      if (unverified[c.candidateId]) errors.push(`${id}: ${c.candidateId} is both published and left out as unverified`);
      const other = owner.get(c.candidateId);
      if (other) errors.push(`${c.candidateId} is credited to both ${other} and ${id}`);
      owner.set(c.candidateId, id);
      const before = prevEnd.get(c.candidateId)?.end;
      if (before && c.coverageEnd < before) errors.push(`${id}: ${c.candidateId} reports now end ${c.coverageEnd}, earlier than ${before} at the last pull`);
    }
  }
  // Only while the member is still current and still linked to the id: an id the roster has
  // since unlinked is never asked about again, and must not block every later run.
  for (const [candidateId, { member }] of prevEnd)
    if (snap.members[member]?.candidateIds.includes(candidateId) && !owner.has(candidateId) && !unverified[candidateId])
      errors.push(`${member}: ${candidateId} had ${cycle - 1}–${cycle} reports at the last pull but none now`);
  const urls = [...snap.sources.map((s) => s.url), ...Object.values(snap.members).flatMap((m) => m.campaigns.map((c) => c.sourceUrl))];
  if (urls.some((u) => /api_key/i.test(u))) errors.push("An API key is in a stored URL");
  return errors;
}
