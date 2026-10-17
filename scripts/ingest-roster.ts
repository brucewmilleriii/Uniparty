/*
 * Fetch the current congressional roster from unitedstates/congress-legislators,
 * validate it, and write data/roster.json. When SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are set it also upserts into Supabase.
 *
 *   npm run ingest:roster              # fetch from the source
 *   npm run ingest:roster -- --from ./dir   # use local copies of the three files
 *
 * Exits non-zero, leaving the existing snapshot untouched, if validation fails.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ROSTER_SOURCE,
  transformRoster,
  validateRoster,
  type RawCommittee,
  type RawLegislator,
  type RawMembership,
} from "../lib/ingest/roster";
import { writeRosterToSupabase } from "../lib/ingest/supabase-writer";
import type { RosterSnapshot, SourceFile } from "../lib/types";

const OUT = path.join(process.cwd(), "data", "roster.json");

async function load(file: string, fromDir: string | null): Promise<{ json: unknown; meta: SourceFile }> {
  const url = `${ROSTER_SOURCE.base}/${file}`;
  let text: string;
  let lastModified: string | null = null;
  let etag: string | null = null;
  if (fromDir) {
    text = await readFile(path.join(fromDir, file), "utf8");
  } else {
    const res = await fetch(url, { headers: { "User-Agent": "uniparty-ingest" } });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    text = await res.text();
    lastModified = res.headers.get("last-modified");
    etag = res.headers.get("etag");
  }
  const sha256 = createHash("sha256").update(text).digest("hex");
  return { json: JSON.parse(text), meta: { url, sha256, bytes: Buffer.byteLength(text), lastModified, etag } };
}

async function main() {
  const fromIdx = process.argv.indexOf("--from");
  const fromDir = fromIdx > -1 ? process.argv[fromIdx + 1] : null;
  const { files } = ROSTER_SOURCE;

  const [leg, com, mem] = await Promise.all([
    load(files.legislators, fromDir),
    load(files.committees, fromDir),
    load(files.membership, fromDir),
  ]);

  const members = transformRoster(
    leg.json as RawLegislator[],
    com.json as RawCommittee[],
    mem.json as RawMembership,
  ).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.name.localeCompare(b.name));

  const errors = validateRoster(members);
  if (errors.length) {
    console.error(`Roster failed validation (${errors.length} problems); keeping the previous snapshot.`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }

  const senate = members.filter((m) => m.chamber === "senate").length;
  const snapshot: RosterSnapshot = {
    provenance: {
      source: ROSTER_SOURCE.source,
      sourceHome: ROSTER_SOURCE.sourceHome,
      fetchedAt: new Date().toISOString(),
      files: [leg.meta, com.meta, mem.meta],
    },
    counts: { senate, house: members.length - senate, total: members.length },
    members,
  };

  // Skip the write when the source content is unchanged, so the scheduled job
  // only commits (and redeploys) when something actually changed upstream.
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8")) as RosterSnapshot;
    const same = prev.provenance.files.map((f) => f.sha256).join() === snapshot.provenance.files.map((f) => f.sha256).join();
    if (same && !process.argv.includes("--force")) {
      console.log(`Source unchanged since ${prev.provenance.fetchedAt}; snapshot left as is.`);
      await maybeSupabase(snapshot);
      return;
    }
  } catch {
    // No previous snapshot yet.
  }

  await writeFile(OUT, JSON.stringify(snapshot, null, 1) + "\n");
  console.log(`Wrote ${members.length} members (${senate} Senate, ${members.length - senate} House) to ${path.relative(process.cwd(), OUT)}`);
  await maybeSupabase(snapshot);
}

async function maybeSupabase(snapshot: RosterSnapshot) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const n = await writeRosterToSupabase(url, key, snapshot);
  console.log(`Upserted ${n} members into Supabase.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
