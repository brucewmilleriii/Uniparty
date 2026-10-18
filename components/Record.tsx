import type { MemberVoteRow, MemberVotes } from "@/lib/data";
import { fmtDate } from "@/lib/format";
import { positionBucket } from "@/lib/ingest/votes";
import type { VoteSummary } from "@/lib/summary";

const clip = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

const LABEL = { yea: "Yea", nay: "Nay", notVoting: "Missed", present: "Present", other: "Other" } as const;

/** The member's recent roll calls as one square each (oldest first), how often they sided with their party, and their latest break. */
export default function Record({
  votes,
  summary,
  lastName,
  partyName,
}: {
  votes: MemberVotes;
  summary: VoteSummary<MemberVoteRow>;
  lastName: string;
  partyName: string;
}) {
  const rows = [...votes.rows].reverse();
  if (!rows.length) return null;
  const first = rows[0].vote.date;
  const last = rows[rows.length - 1].vote.date;
  const brk = summary.breaks[0];
  const pct = summary.comparable ? Math.round((summary.withParty / summary.comparable) * 100) : null;

  return (
    <section className="sec" aria-labelledby="record-h">
      <h3 className="sec-h" id="record-h">
        The record at a glance
        <span>
          last {rows.length} roll calls · {fmtDate(first)} – {fmtDate(last)}
        </span>
      </h3>
      <div className="glance">
        <div style={{ minWidth: 0 }}>
          <div className="strip" role="img" aria-label={`${lastName}'s last ${rows.length} votes, oldest first`}>
            {rows.map(({ vote: v, position }) => (
              <span
                key={v.id}
                className={`vc v-${positionBucket(position)}`}
                title={`Roll ${v.rollNumber} · ${fmtDate(v.date)}${v.measure ? ` · ${v.measure}` : ""} · ${position}`}
              />
            ))}
          </div>
          <div className="strip-axis">
            <span>{fmtDate(first)}</span>
            <span>{fmtDate(last)}</span>
          </div>
          <div className="keys">
            {(["yea", "nay", "notVoting", "present"] as const).map((k) => (
              <span key={k}>
                <i className={`vc v-${k}`} />
                {LABEL[k]}
              </span>
            ))}
          </div>
          {pct !== null && (
            <div className="meter">
              <div className="row">
                <span>Sided with most {partyName}s</span>
                <b>
                  {summary.withParty} of {summary.comparable}
                </b>
              </div>
              <div className="track">
                <i style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </div>
        {pct !== null && (
          <div className="box">
            <span className="kicker">Breaking ranks</span>
            {brk ? (
              <>
                <p>
                  {summary.breaks.length === 1 ? "Their one vote" : `Latest of ${summary.breaks.length} votes`} against most {partyName}s
                  here: <b>{brk.position}</b> on <b>{brk.vote.measure ?? `roll ${brk.vote.rollNumber}`}</b>
                  {brk.vote.description ? `, ${clip(brk.vote.description)},` : ""} on {fmtDate(brk.vote.date)}.{" "}
                  {brk.vote.result}
                  {brk.vote.totals ? ` ${brk.vote.totals.yea}–${brk.vote.totals.nay}.` : "."}
                </p>
                <a className="mono" href={brk.vote.pageUrl} target="_blank" rel="noopener">
                  Roll {brk.vote.rollNumber}, official record ↗
                </a>
              </>
            ) : (
              <p>
                {lastName} voted with most {partyName}s on every one of these roll calls where both voted Yea or Nay.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
