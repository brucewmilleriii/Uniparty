import { measureRef } from "@/lib/ingest/votes";
import type { Bill, BillLink, BillsSnapshot, MemberBills } from "@/lib/types";

/*
 * Parse and validate each member's sponsored and cosponsored bills from the
 * Congress.gov API. Pure functions only: fetching and writing live in
 * scripts/ingest-bills.ts.
 */

/** How many of a member's most recent bills to keep for each of sponsored and cosponsored. */
export const BILL_WINDOW = 10;

/** Members Congress.gov may not list yet (just sworn in) before the run counts as failed. */
export const MAX_MISSING_MEMBERS = 3;

export const BILLS_SOURCE = { source: "Congress.gov", sourceHome: "https://www.congress.gov/" } as const;

export const API_BASE = "https://api.congress.gov/v3";

export type LegislationKind = "sponsored" | "cosponsored";

/** The member's list endpoint. The API key goes in a header, never in a URL that gets stored. */
export const memberLegislationUrl = (bioguideId: string, kind: LegislationKind, offset = 0, base = API_BASE) =>
  `${base}/member/${bioguideId}/${kind}-legislation?format=json&limit=250${offset ? `&offset=${offset}` : ""}`;
export const billUrl = (congress: number, type: string, number: number, base = API_BASE) =>
  `${base}/bill/${congress}/${type.toLowerCase()}/${number}?format=json`;
export const billCosponsorsUrl = (congress: number, type: string, number: number, offset = 0, base = API_BASE) =>
  `${base}/bill/${congress}/${type.toLowerCase()}/${number}/cosponsors?format=json&limit=250${offset ? `&offset=${offset}` : ""}`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** One page of /member/{id}/sponsored-legislation or /cosponsored-legislation. */
export interface LegislationPage {
  items: Obj[];
  /** Everything the member has ever (co)sponsored, across all Congresses, amendments included. */
  count: number;
  next: string | null;
}

export function readLegislationPage(body: unknown, kind: LegislationKind): LegislationPage {
  const key = kind === "sponsored" ? "sponsoredLegislation" : "cosponsoredLegislation";
  if (!isObj(body) || !Array.isArray(body[key]) || !isObj(body.pagination))
    throw new Error(`Not a Congress.gov ${kind}-legislation page`);
  const count = body.pagination.count;
  if (typeof count !== "number") throw new Error(`${kind}-legislation page has no pagination count`);
  return { items: (body[key] as unknown[]).filter(isObj), count, next: str(body.pagination.next) || null };
}

/**
 * Whether to fetch another page. Congress.gov orders these lists neither by date nor
 * by Congress (a current bill can follow one from years ago), so the only way to be
 * sure of every current-Congress item is to read the whole list.
 */
export const needsNextPage = (page: LegislationPage) => page.next !== null && page.items.length > 0;

export interface ParsedLink {
  bill: Omit<Bill, "fetchedAt">;
  date: string;
}

export interface ParsedLegislation {
  /** Bills and resolutions in the current Congress, newest first by date. */
  links: ParsedLink[];
  amendments: number;
  errors: string[];
}

/**
 * Read a member's pages for the current Congress and check them: every item must be
 * a well-formed bill in a Congress no later than the current one, with no repeats,
 * and the whole list must be there: it has to end exactly at the count Congress.gov
 * reports, so a truncated response can't pass as complete. Items from earlier
 * Congresses are skipped wherever they appear, and the links come back sorted newest
 * first by their own date, since the source order is neither.
 */
export function parseLegislation(pages: LegislationPage[], kind: LegislationKind, bioguideId: string, congress: number, today = new Date()): ParsedLegislation {
  const at = `${bioguideId} ${kind}`;
  const errors: string[] = [];
  const links: ParsedLink[] = [];
  const seen = new Set<string>();
  let amendments = 0;
  let listed = 0;

  for (const item of pages.flatMap((p) => p.items)) {
    listed++;
    const c = Number(item.congress);
    const date = str(item.introducedDate);
    if (!Number.isInteger(c) || c < 1 || c > congress) {
      errors.push(`${at}: item ${listed} is in an impossible Congress (${String(item.congress)})`);
      continue;
    }
    if (!isDate(date)) {
      errors.push(`${at}: item ${listed} has an unreadable date "${date}"`);
      continue;
    }
    if (c < congress) continue;
    if (Date.parse(date) > today.getTime() + 86_400_000) errors.push(`${at}: item ${listed} is dated in the future (${date})`);
    if (item.amendmentNumber !== undefined) {
      amendments++;
      continue;
    }

    const type = str(item.type).toUpperCase();
    const number = Number(str(item.number));
    const id = `${c}-${type.toLowerCase()}-${number}`;
    const { measure, measureUrl } = measureRef(`${type} ${number}`, c);
    if (!measureUrl || !measure || !(Number.isInteger(number) && number > 0)) {
      errors.push(`${at}: item ${listed} is not a recognisable bill (${type} ${str(item.number)})`);
      continue;
    }
    const apiUrl = `${API_BASE}/bill/${c}/${type.toLowerCase()}/${number}`;
    if (str(item.url).split("?")[0] !== apiUrl) errors.push(`${at}: ${measure} points at ${str(item.url)}, expected ${apiUrl}`);
    const title = str(item.title) || str(item.latestTitle);
    if (!title) errors.push(`${at}: ${measure} has no title`);
    if (seen.has(id)) errors.push(`${at}: ${measure} is listed twice`);
    seen.add(id);

    const la = isObj(item.latestAction) ? item.latestAction : null;
    const laDate = la ? str(la.actionDate) : "";
    if (la && !isDate(laDate)) errors.push(`${at}: ${measure} has an unreadable latest action date "${laDate}"`);
    const policy = isObj(item.policyArea) ? str(item.policyArea.name) : "";

    links.push({
      date,
      bill: {
        id,
        congress: c,
        type,
        number,
        label: measure,
        title,
        policyArea: policy || null,
        latestAction: la && laDate ? { date: laDate, text: str(la.text) } : null,
        pageUrl: measureUrl,
        sourceUrl: apiUrl,
      },
    });
  }

  // Newest first by date; ties keep the source order.
  links.sort((a, b) => b.date.localeCompare(a.date));

  const last = pages[pages.length - 1];
  if (!pages.length) errors.push(`${at}: no pages fetched`);
  else if (last.next !== null) errors.push(`${at}: stopped before the end of the list`);
  else if (listed !== last.count) errors.push(`${at}: list ended after ${listed} items but Congress.gov reports ${last.count}; response looks truncated`);
  return { links, amendments, errors };
}

/**
 * Check a sampled sponsored bill against the bill's own record:
 * the sponsor, title and date in the member's list must match /bill/{congress}/{type}/{number}.
 */
export function checkSponsor(body: unknown, link: ParsedLink | (BillLink & { bill: Pick<Bill, "label" | "title"> }), bioguideId: string): string[] {
  const at = `${bioguideId} sponsored ${link.bill.label}`;
  const bill = isObj(body) && isObj(body.bill) ? body.bill : null;
  if (!bill) return [`${at}: bill record is unreadable`];
  const sponsors = Array.isArray(bill.sponsors) ? bill.sponsors.filter(isObj) : [];
  const errors: string[] = [];
  if (sponsors.length !== 1 || str(sponsors[0].bioguideId) !== bioguideId)
    errors.push(`${at}: bill record names sponsor ${sponsors.map((s) => str(s.bioguideId)).join(", ") || "none"}`);
  if (str(bill.introducedDate) !== link.date) errors.push(`${at}: bill record says introduced ${str(bill.introducedDate)}, member list says ${link.date}`);
  if (str(bill.title) !== link.bill.title) errors.push(`${at}: bill record title differs from the member list`);
  return errors;
}

/** Check a sampled cosponsored bill: the bill's cosponsor list must include the member, signed on the listed date. */
export function checkCosponsor(pages: unknown[], link: Pick<ParsedLink, "date"> & { bill: Pick<Bill, "label"> }, bioguideId: string): string[] {
  const at = `${bioguideId} cosponsored ${link.bill.label}`;
  const rows = pages.flatMap((p) => (isObj(p) && Array.isArray(p.cosponsors) ? p.cosponsors.filter(isObj) : []));
  if (!rows.length) return [`${at}: bill has no readable cosponsor list`];
  const row = rows.find((r) => str(r.bioguideId) === bioguideId);
  if (!row) return [`${at}: member is not on the bill's cosponsor list`];
  if (str(row.sponsorshipDate) !== link.date) return [`${at}: bill says signed on ${str(row.sponsorshipDate)}, member list says ${link.date}`];
  return [];
}

/** Next page of a bill's cosponsor list, if any. */
export const cosponsorsNext = (body: unknown): string | null =>
  isObj(body) && isObj(body.pagination) ? str(body.pagination.next) || null : null;

/** Combine a member's two parsed lists into the stored record, adding their bills to `bills`. */
export function toMemberBills(
  sponsored: ParsedLegislation,
  cosponsored: ParsedLegislation,
  sources: MemberBills["sources"],
  fetchedAt: string,
  bills: Record<string, Bill>,
  window = BILL_WINDOW,
): MemberBills {
  const keep = (links: ParsedLink[]): BillLink[] =>
    links.slice(0, window).map(({ bill, date }) => {
      bills[bill.id] = { ...bill, fetchedAt };
      return { billId: bill.id, date };
    });
  return {
    sponsoredCount: sponsored.links.length,
    cosponsoredCount: cosponsored.links.length,
    sponsored: keep(sponsored.links),
    cosponsored: keep(cosponsored.links),
    sources,
    fetchedAt,
  };
}

/**
 * Whole-snapshot checks run before writing: every roster member is covered,
 * every listed bill exists, no bill has two sponsors, and no member's sponsored
 * count went down since the last good pull (bills can't be un-introduced).
 */
export function validateBillsSnapshot(snap: BillsSnapshot, rosterIds: string[], previous: BillsSnapshot | null): string[] {
  const errors: string[] = [];
  const missing = rosterIds.filter((id) => !snap.members[id]);
  if (missing.length > MAX_MISSING_MEMBERS) errors.push(`${missing.length} members have no bill record (${missing.slice(0, 5).join(", ")})`);

  const sponsorOf = new Map<string, string>();
  for (const [id, m] of Object.entries(snap.members)) {
    if (!m.sources.length || m.sources.some((s) => !/^[0-9a-f]{64}$/.test(s.sha256) || !s.url.startsWith("https://")))
      errors.push(`${id} has no source hash or URL`);
    if (m.sources.some((s) => /api_key/i.test(s.url))) errors.push(`${id} has an API key in a stored URL`);
    if (m.sponsored.length > m.sponsoredCount || m.cosponsored.length > m.cosponsoredCount) errors.push(`${id} lists more bills than its count`);
    for (const l of [...m.sponsored, ...m.cosponsored]) if (!snap.bills[l.billId]) errors.push(`${id} lists ${l.billId}, which is missing`);
    for (const l of m.sponsored) {
      const other = sponsorOf.get(l.billId);
      if (other) errors.push(`${l.billId} is listed as sponsored by both ${other} and ${id}`);
      sponsorOf.set(l.billId, id);
    }
    const own = new Set(m.sponsored.map((l) => l.billId));
    for (const l of m.cosponsored) if (own.has(l.billId)) errors.push(`${id} both sponsors and cosponsors ${l.billId}`);

    const before = previous?.provenance.congress === snap.provenance.congress ? previous.members[id] : undefined;
    if (before && m.sponsoredCount < before.sponsoredCount)
      errors.push(`${id}: sponsored count fell from ${before.sponsoredCount} to ${m.sponsoredCount} within the ${snap.provenance.congress}th Congress`);
  }
  for (const b of Object.values(snap.bills)) {
    if (b.congress !== snap.provenance.congress) errors.push(`${b.id} is not in the ${snap.provenance.congress}th Congress`);
    if (!b.sourceUrl.startsWith("https://") || !b.pageUrl.startsWith("https://www.congress.gov/")) errors.push(`${b.id} has no source URL`);
  }
  if (Object.keys(snap.members).length && !Object.keys(snap.bills).length) errors.push("No bills at all; source looks empty");
  return errors;
}
