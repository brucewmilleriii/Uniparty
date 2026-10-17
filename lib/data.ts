import "server-only";
import { createClient } from "@supabase/supabase-js";
import snapshot from "@/data/roster.json";
import votesSnapshot from "@/data/votes.json";
import { compareVotes } from "@/lib/ingest/votes";
import type { Member, RosterSnapshot, Vote, VotesSnapshot } from "@/lib/types";

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

const localVotes = votesSnapshot as VotesSnapshot;

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
