# Components

Stack: Next.js 16 App Router, React 19, TypeScript. No component library and no Tailwind; plain global CSS classes in `app/globals.css`. Shared components live in `components/`.

- `Provenance` — source + pulled-date line shown under every dataset. Props: data {source, sourceHome, fetchedAt}, what.
- `RecentVotes` — roll-call votes table with Yea/Nay chips and a Yea-share tally bar. Props: votes, lastName.
- `Bills` — sponsored/cosponsored counts and bill tables. Props: bills, lastName, allUrl.

### `components/Provenance.tsx`

```tsx
import { fmtDate } from "@/lib/format";

export interface ProvenanceInfo {
  source: string;
  sourceHome: string;
  /** Null when the dataset hasn't been pulled yet. */
  fetchedAt: string | null;
}

/** The "where this came from and when" line shown under every dataset. */
export default function Provenance({ data, what = "Roster and committees" }: { data: ProvenanceInfo; what?: string }) {
  return (
    <div className="prov">
      <span className="ok" aria-hidden="true" />
      <span>
        {what} from <a href={data.sourceHome} target="_blank" rel="noopener">{data.source}</a>
      </span>
      {data.fetchedAt ? (
        <span>
          Pulled <time dateTime={data.fetchedAt}>{fmtDate(data.fetchedAt)}</time> · checked daily
        </span>
      ) : (
        <span>Not pulled yet</span>
      )}
    </div>
  );
}

```

### `components/RecentVotes.tsx`

```tsx
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

```

### `components/Bills.tsx`

```tsx
import Provenance from "@/components/Provenance";
import type { MemberBillRow, MemberBillsView } from "@/lib/data";
import { fmtDate, ordinal } from "@/lib/format";

function Table({ rows, dateLabel }: { rows: MemberBillRow[]; dateLabel: string }) {
  return (
    <div className="scroll">
      <table className="bills">
        <thead>
          <tr>
            <th>Bill</th>
            <th>{dateLabel}</th>
            <th>Title</th>
            <th>Latest action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ bill: b, date }) => (
            <tr key={b.id}>
              <td className="measure">
                <a href={b.pageUrl} target="_blank" rel="noopener" title="This bill on Congress.gov">
                  {b.label}
                </a>
              </td>
              <td className="mono dim" style={{ whiteSpace: "nowrap" }}>
                {fmtDate(date)}
              </td>
              <td className="bt">
                {b.title}
                {b.policyArea && <div className="res">{b.policyArea}</div>}
              </td>
              <td className="ba">
                {b.latestAction ? (
                  <>
                    <span className="mono dim">{fmtDate(b.latestAction.date)}</span>
                    <div className="res">{b.latestAction.text}</div>
                  </>
                ) : (
                  <span className="dim">None recorded</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A member's bill counts for the current Congress and their most recent sponsored and cosponsored bills. */
export default function Bills({ bills, lastName, allUrl }: { bills: MemberBillsView; lastName: string; allUrl: string }) {
  const congress = `${ordinal(bills.congress)} Congress`;
  const pulled = bills.fetchedAt !== null;

  return (
    <div className="card">
      <div className="panel">
        <div className="h3">Bills</div>
        {!pulled ? (
          <p className="panel-note">
            Bills haven’t been pulled from Congress.gov yet. They appear here after the first daily refresh. Until then,{" "}
            <a href={allUrl} target="_blank" rel="noopener">
              see {lastName}’s bills on Congress.gov ↗
            </a>
          </p>
        ) : bills.sponsoredCount === null ? (
          <p className="panel-note">
            Congress.gov had no record for {lastName} at the last pull, which usually means they were sworn in very recently.{" "}
            <a href={allUrl} target="_blank" rel="noopener">
              Check Congress.gov ↗
            </a>
          </p>
        ) : (
          <>
            <div className="stats2">
              <div className="stat">
                <div className="k">Sponsored</div>
                <div className="v">{bills.sponsoredCount.toLocaleString("en-US")}</div>
              </div>
              <div className="stat">
                <div className="k">Cosponsored</div>
                <div className="v">{(bills.cosponsoredCount ?? 0).toLocaleString("en-US")}</div>
              </div>
            </div>
            <p className="panel-note">
              Bills and resolutions in the {congress}, not counting amendments. Each bill number links to Congress.gov, and{" "}
              <a href={allUrl} target="_blank" rel="noopener">
                {lastName}’s full list is there too ↗
              </a>
            </p>
            {bills.sponsored.length > 0 && (
              <>
                <div className="h4">Recently sponsored</div>
                <Table rows={bills.sponsored} dateLabel="Introduced" />
              </>
            )}
            {bills.cosponsored.length > 0 && (
              <>
                <div className="h4">Recently cosponsored</div>
                <Table rows={bills.cosponsored} dateLabel="Signed on" />
              </>
            )}
          </>
        )}
        <div className="src">
          <Provenance data={bills} what="Bills" />
        </div>
      </div>
    </div>
  );
}

```

