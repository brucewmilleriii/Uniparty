import "server-only";
import { createClient } from "@supabase/supabase-js";
import snapshot from "@/data/roster.json";
import billsSnapshot from "@/data/bills.json";
import votesSnapshot from "@/data/votes.json";
import { compareVotes } from "@/lib/ingest/votes";
import type { Bill, BillsSnapshot, Member, RosterSnapshot, Vote, VotesSnapshot } from "@/lib/types";

/*
 * Roster reads. With SUPABASE_URL and SUPABASE_ANON_KEY set, members come from
 * Supabase; otherwise from the validated snapshot committed in data/roster.json.
 * Either way the result carries provenance for the "last updated" line.
 */

export interface Roster {
  members: Member[];
  fetchedAt: string;
  source: string;
  sourceHome: string;
  backend: "supabase" | "snapshot";
}

const local = snapshot as RosterSnapshot;

function fromSnapshot(): Roster {
  const { fetchedAt, source, sourceHome } = local.provenance;
  return { members: local.members, fetchedAt, source, sourceHome, backend: "snapshot" };
}

async function fromSupabase(url: string, key: string): Promise<Roster> {
  const db = createClient(url, key, { auth: { persistSession: false } });
  const [members, seats, run] = await Promise.all([
    db.from("members").select("*").eq("in_office", true).order("last_name"),
    db.from("committee_seats").select("bioguide_id, committee_id, committee_name, title"),
    db.from("ingest_runs").select("fetched_at").eq("source", "roster").eq("status", "ok").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (members.error) throw new Error(`Supabase members: ${members.error.message}`);
  if (seats.error) throw new Error(`Supabase committee_seats: ${seats.error.message}`);

  const byMember = new Map<string, Member["committees"]>();
  for (const s of seats.data) {
    const list = byMember.get(s.bioguide_id) ?? [];
    list.push({ committeeId: s.committee_id, name: s.committee_name, title: s.title });
    byMember.set(s.bioguide_id, list);
  }
  return {
    members: members.data.map((r) => ({
      bioguideId: r.bioguide_id,
      name: r.name,
      lastName: r.last_name,
      chamber: r.chamber,
      state: r.state,
      district: r.district,
      party: r.party,
      partyName: r.party_name,
      servingSince: r.serving_since,
      termStart: r.term_start,
      termEnd: r.term_end,
      phone: r.phone,
      website: r.website,
      office: r.office,
      birthday: r.birthday,
      fecIds: r.fec_ids,
      lisId: r.lis_id,
      committees: byMember.get(r.bioguide_id) ?? [],
    })),
    fetchedAt: run.data?.fetched_at ?? members.data[0]?.fetched_at ?? local.provenance.fetchedAt,
    source: local.provenance.source,
    sourceHome: local.provenance.sourceHome,
    backend: "supabase",
  };
}

export async function getRoster(): Promise<Roster> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (url && key) return fromSupabase(url, key);
  return fromSnapshot();
}

export async function getMember(id: string): Promise<{ member: Member | undefined; roster: Roster }> {
  const roster = await getRoster();
  return { member: roster.members.find((m) => m.bioguideId === id), roster };
}

export interface MemberVoteRow {
  vote: Omit<Vote, "positions">;
  /** The member's position, as the chamber recorded it. */
  position: string;
}

export interface MemberVotes {
  /** Newest first: every roll call in the window that the member was eligible for. */
  rows: MemberVoteRow[];
  /** Roll calls in the window for the member's chamber, whether or not they were in office for all of them. */
  window: number;
  source: string;
  sourceHome: string;
  fetchedAt: string | null;
}

const localVotes = votesSnapshot as unknown as VotesSnapshot;

function votesFromSnapshot(m: Member): MemberVotes {
  const { fetchedAt, window } = localVotes.provenance;
  const rows = localVotes.votes
    .filter((v) => v.chamber === m.chamber && v.positions[m.bioguideId] !== undefined)
    .sort(compareVotes)
    .map(({ positions, ...vote }) => ({ vote, position: positions[m.bioguideId] }));
  return { rows, window, fetchedAt, ...localVotes.provenance[m.chamber] };
}

async function votesFromSupabase(m: Member, url: string, key: string): Promise<MemberVotes> {
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { window } = localVotes.provenance;
  const [recent, run] = await Promise.all([
    db.from("votes").select("*").eq("chamber", m.chamber).order("vote_date", { ascending: false }).order("roll_number", { ascending: false }).limit(window),
    db.from("ingest_runs").select("fetched_at").eq("source", "votes").eq("status", "ok").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (recent.error) throw new Error(`Supabase votes: ${recent.error.message}`);
  const ids = recent.data.map((r) => r.id);
  const pos = ids.length
    ? await db.from("vote_positions").select("vote_id, position").eq("bioguide_id", m.bioguideId).in("vote_id", ids)
    : { data: [], error: null };
  if (pos.error) throw new Error(`Supabase vote_positions: ${pos.error.message}`);
  const byVote = new Map(pos.data.map((p) => [p.vote_id, p.position as string]));

  const rows = recent.data
    .filter((r) => byVote.has(r.id))
    .map((r) => ({
      vote: {
        id: r.id,
        chamber: r.chamber,
        congress: r.congress,
        session: r.session,
        rollNumber: r.roll_number,
        date: r.vote_date,
        time: r.vote_time,
        question: r.question,
        description: r.description,
        measure: r.measure,
        measureUrl: r.measure_url,
        result: r.result,
        totals: r.totals,
        pageUrl: r.page_url,
        sourceUrl: r.source_url,
        sha256: r.sha256,
        fetchedAt: r.fetched_at,
      },
      position: byVote.get(r.id)!,
    }))
    .sort((a, b) => compareVotes(a.vote, b.vote));
  return { rows, window, fetchedAt: run.data?.fetched_at ?? null, ...localVotes.provenance[m.chamber] };
}

/** A member's positions on the most recent roll calls in their chamber. */
export async function getMemberVotes(m: Member): Promise<MemberVotes> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (url && key) return votesFromSupabase(m, url, key);
  return votesFromSnapshot(m);
}

/** Freshness of the vote data, for the health check. */
export function votesStatus() {
  const latest = (chamber: "house" | "senate") => localVotes.votes.filter((v) => v.chamber === chamber).sort(compareVotes)[0]?.date ?? null;
  return { rollCalls: localVotes.votes.length, fetchedAt: localVotes.provenance.fetchedAt, latestHouse: latest("house"), latestSenate: latest("senate") };
}

export interface MemberBillRow {
  bill: Bill;
  /** Introduced (sponsored) or signed on (cosponsored). */
  date: string;
}

export interface MemberBillsView {
  congress: number;
  /** Null when Congress.gov had no record of this member at the last pull. */
  sponsoredCount: number | null;
  cosponsoredCount: number | null;
  sponsored: MemberBillRow[];
  cosponsored: MemberBillRow[];
  source: string;
  sourceHome: string;
  fetchedAt: string | null;
}

const localBills = billsSnapshot as unknown as BillsSnapshot;

function billsFromSnapshot(m: Member): MemberBillsView {
  const { congress, fetchedAt, source, sourceHome } = localBills.provenance;
  const mb = localBills.members[m.bioguideId];
  const rows = (links: { billId: string; date: string }[] = []) => links.map((l) => ({ bill: localBills.bills[l.billId], date: l.date }));
  return {
    congress,
    sponsoredCount: mb?.sponsoredCount ?? null,
    cosponsoredCount: mb?.cosponsoredCount ?? null,
    sponsored: rows(mb?.sponsored),
    cosponsored: rows(mb?.cosponsored),
    source,
    sourceHome,
    fetchedAt,
  };
}

async function billsFromSupabase(m: Member, url: string, key: string): Promise<MemberBillsView> {
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { congress, window, source, sourceHome } = localBills.provenance;
  const recent = (role: "sponsor" | "cosponsor") =>
    db.from("member_bills").select("link_date, bills!inner(*)").eq("bioguide_id", m.bioguideId).eq("role", role).eq("bills.congress", congress).order("link_date", { ascending: false }).limit(window);
  const [counts, sp, co, run] = await Promise.all([
    db.from("member_bill_counts").select("*").eq("bioguide_id", m.bioguideId).eq("congress", congress).maybeSingle(),
    recent("sponsor"),
    recent("cosponsor"),
    db.from("ingest_runs").select("fetched_at").eq("source", "bills").eq("status", "ok").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [counts, sp, co]) if (r.error) throw new Error(`Supabase bills: ${r.error.message}`);
  const rows = (data: { link_date: string; bills: unknown }[] | null): MemberBillRow[] =>
    (data ?? []).map((r) => {
      const b = r.bills as Record<string, never>;
      return {
        date: r.link_date,
        bill: {
          id: b.id,
          congress: b.congress,
          type: b.type,
          number: b.number,
          label: b.label,
          title: b.title,
          policyArea: b.policy_area,
          latestAction: b.latest_action_date ? { date: b.latest_action_date, text: b.latest_action_text ?? "" } : null,
          pageUrl: b.page_url,
          sourceUrl: b.source_url,
          fetchedAt: b.fetched_at,
        },
      };
    });
  return {
    congress,
    sponsoredCount: counts.data?.sponsored_count ?? null,
    cosponsoredCount: counts.data?.cosponsored_count ?? null,
    sponsored: rows(sp.data),
    cosponsored: rows(co.data),
    source,
    sourceHome,
    fetchedAt: run.data?.fetched_at ?? null,
  };
}

/** A member's bill counts for the current Congress and their most recent sponsored and cosponsored bills. */
export async function getMemberBills(m: Member): Promise<MemberBillsView> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (url && key) return billsFromSupabase(m, url, key);
  return billsFromSnapshot(m);
}

/** Freshness of the bill data, for the health check. */
export function billsStatus() {
  const { congress, fetchedAt } = localBills.provenance;
  return { congress, members: Object.keys(localBills.members).length, bills: Object.keys(localBills.bills).length, fetchedAt };
}
