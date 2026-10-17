import Provenance from "@/components/Provenance";
import type { MemberVoteRow, MemberVotes } from "@/lib/data";
import { fmtDate } from "@/lib/format";
import { positionBucket } from "@/lib/ingest/votes";

const SHOWN = 20;

function chip(position: string) {
  const b = positionBucket(position);
  return b === "yea" ? "v-Yea" : b === "nay" ? "v-Nay" : "v-NV";
}

function Row({ vote: v, position }: MemberVoteRow) {
  const t = v.totals;
  const decided = t ? t.yea + t.nay : 0;
  return (
    <tr>
      <td className="mono">
        <a href={v.pageUrl} target="_blank" rel="noopener" title="Official record of this roll call">
          {v.rollNumber}
        </a>
      </td>
      <td className="mono dim" style={{ whiteSpace: "nowrap" }}>
        {fmtDate(v.date)}
      </td>
      <td className="vm">
        {v.measure && (
          <span className="measure">
            {v.measureUrl ? (
              <a href={v.measureUrl} target="_blank" rel="noopener">
                {v.measure}
              </a>
            ) : (
              v.measure
            )}
          </span>
        )}
        {v.measure && v.description && " · "}
        {v.description || (!v.measure && <span className="measure">{v.question}</span>)}
        {(v.measure || v.description) && <div className="res">{v.question}</div>}
      </td>
      <td>
        <span className={`vchip ${chip(position)}`}>{position}</span>
      </td>
      <td>
        {t && decided > 0 ? (
          <div className="tally">
            <span className="t">
              <i style={{ width: `${((t.yea / decided) * 100).toFixed(1)}%` }} />
            </span>
            {t.yea}–{t.nay}
          </div>
        ) : t && t.present > 0 ? (
          <div className="tally">{t.present} present</div>
        ) : null}
        <div className="res">{v.result}</div>
      </td>
    </tr>
  );
}

function Table({ rows }: { rows: MemberVoteRow[] }) {
  return (
    <div className="scroll">
      <table className="votes">
        <thead>
          <tr>
            <th>Roll</th>
            <th>Date</th>
            <th>Measure</th>
            <th>Vote</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.vote.id} {...r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A member's positions on the most recent roll calls in their chamber, with attendance. */
export default function RecentVotes({ votes, lastName }: { votes: MemberVotes; lastName: string }) {
  const { rows } = votes;
  const missed = rows.filter((r) => positionBucket(r.position) === "notVoting").length;
  const pct = rows.length ? Math.round((missed / rows.length) * 100) : 0;

  return (
    <div className="card">
      <div className="panel">
        <div className="h3">Recent votes</div>
        {rows.length ? (
          <>
            <p className="panel-note">
              {lastName} missed <b>{missed}</b> of the last {rows.length} roll calls ({pct}%). Each roll number links to the official
              record.
            </p>
            <div className="legend">
              <span className="vchip v-Yea">Yea</span>
              <span className="vchip v-Nay">Nay</span>
              <span>Bar shows the share of Yea votes in the chamber.</span>
            </div>
            <Table rows={rows.slice(0, SHOWN)} />
            {rows.length > SHOWN && (
              <details className="more">
                <summary>Show {rows.length - SHOWN} earlier roll calls</summary>
                <Table rows={rows.slice(SHOWN)} />
              </details>
            )}
          </>
        ) : (
          <p className="panel-note">
            {votes.fetchedAt
              ? `No recorded votes for ${lastName} in the last ${votes.window} roll calls.`
              : "Roll-call votes haven’t been pulled yet. They appear here after the first daily refresh."}
          </p>
        )}
        <div className="src">
          <Provenance data={votes} what="Roll-call votes" />
        </div>
      </div>
    </div>
  );
}
