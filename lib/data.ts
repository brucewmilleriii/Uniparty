import "server-only";
import { createClient } from "@supabase/supabase-js";
import snapshot from "@/data/roster.json";
import type { Member, RosterSnapshot } from "@/lib/types";

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
