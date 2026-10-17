import { createClient } from "@supabase/supabase-js";
import type { RosterSnapshot, Vote } from "@/lib/types";

/**
 * Upsert a validated roster into Supabase and record the run in ingest_runs.
 * Members missing from the new roster are marked out of office, not deleted,
 * so their votes and filings stay attached to them.
 */
export async function writeRosterToSupabase(url: string, serviceKey: string, snap: RosterSnapshot): Promise<number> {
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { fetchedAt, files } = snap.provenance;
  const sourceUrl = files[0].url;

  const fail = async (step: string, message: string): Promise<never> => {
    await db.from("ingest_runs").insert({ source: "roster", fetched_at: fetchedAt, status: "failed", error: `${step}: ${message}` });
    throw new Error(`Supabase ${step} failed: ${message}`);
  };

  const rows = snap.members.map((m) => ({
    bioguide_id: m.bioguideId,
    name: m.name,
    last_name: m.lastName,
    chamber: m.chamber,
    state: m.state,
    district: m.district,
    party: m.party,
    party_name: m.partyName,
    serving_since: m.servingSince,
    term_start: m.termStart,
    term_end: m.termEnd,
    phone: m.phone,
    website: m.website,
    office: m.office,
    birthday: m.birthday,
    fec_ids: m.fecIds,
    lis_id: m.lisId,
    in_office: true,
    source_url: sourceUrl,
    fetched_at: fetchedAt,
  }));
  const up = await db.from("members").upsert(rows, { onConflict: "bioguide_id" });
  if (up.error) await fail("members upsert", up.error.message);

  const ids = snap.members.map((m) => m.bioguideId);
  const gone = await db.from("members").update({ in_office: false }).eq("in_office", true).not("bioguide_id", "in", `(${ids.join(",")})`);
  if (gone.error) await fail("out-of-office update", gone.error.message);

  const seats = snap.members.flatMap((m) =>
    m.committees.map((c) => ({ bioguide_id: m.bioguideId, committee_id: c.committeeId, committee_name: c.name, title: c.title, source_url: files[2].url, fetched_at: fetchedAt })),
  );
  const del = await db.from("committee_seats").delete().neq("bioguide_id", "");
  if (del.error) await fail("committee_seats clear", del.error.message);
  const ins = await db.from("committee_seats").insert(seats);
  if (ins.error) await fail("committee_seats insert", ins.error.message);

  await db.from("ingest_runs").insert({
    source: "roster",
    fetched_at: fetchedAt,
    status: "ok",
    record_count: rows.length,
    source_files: files,
  });
  return rows.length;
}

/**
 * Upsert roll-call votes and every member's position on them, and record the run.
 * Older votes that have left the snapshot's window stay in the database as history.
 */
export async function writeVotesToSupabase(url: string, serviceKey: string, votes: Vote[], fetchedAt: string): Promise<number> {
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const fail = async (step: string, message: string): Promise<never> => {
    await db.from("ingest_runs").insert({ source: "votes", fetched_at: fetchedAt, status: "failed", error: `${step}: ${message}` });
    throw new Error(`Supabase ${step} failed: ${message}`);
  };

  const rows = votes.map((v) => ({
    id: v.id,
    chamber: v.chamber,
    congress: v.congress,
    session: v.session,
    roll_number: v.rollNumber,
    vote_date: v.date,
    vote_time: v.time,
    question: v.question,
    description: v.description,
    measure: v.measure,
    measure_url: v.measureUrl,
    result: v.result,
    totals: v.totals,
    page_url: v.pageUrl,
    source_url: v.sourceUrl,
    sha256: v.sha256,
    fetched_at: v.fetchedAt,
  }));
  const up = await db.from("votes").upsert(rows, { onConflict: "id" });
  if (up.error) await fail("votes upsert", up.error.message);

  const positions = votes.flatMap((v) => Object.entries(v.positions).map(([bioguide_id, position]) => ({ vote_id: v.id, bioguide_id, position })));
  for (let i = 0; i < positions.length; i += 5000) {
    const res = await db.from("vote_positions").upsert(positions.slice(i, i + 5000), { onConflict: "vote_id,bioguide_id" });
    if (res.error) await fail("vote_positions upsert", res.error.message);
  }

  await db.from("ingest_runs").insert({
    source: "votes",
    fetched_at: fetchedAt,
    status: "ok",
    record_count: rows.length,
    source_files: votes.map((v) => ({ url: v.sourceUrl, sha256: v.sha256 })),
  });
  return rows.length;
}
