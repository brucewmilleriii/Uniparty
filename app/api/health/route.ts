import { NextResponse } from "next/server";
import { getRoster, votesStatus } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Machine-readable freshness check, for uptime monitors. */
export async function GET() {
  const roster = await getRoster();
  return NextResponse.json({
    ok: true,
    backend: roster.backend,
    roster: { members: roster.members.length, fetchedAt: roster.fetchedAt, source: roster.source },
    votes: votesStatus(),
  });
}
