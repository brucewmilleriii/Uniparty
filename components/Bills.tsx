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
    <section className="sec" id="bills" aria-labelledby="bills-h">
      <div>
        <h3 className="sec-h" id="bills-h">
          Bills
        </h3>
        {!pulled ? (
          <p className="panel-note">
            Bills haven’t been pulled from Congress.gov yet. They appear here after the first daily refresh. Until then,{" "}
            <a href={allUrl} target="_blank" rel="noopener">
              see {lastName}’s bills on Congress.gov ↗
            </a>
          </p>
        ) : bills.unverified ? (
          <p className="panel-note">
            At the last pull, Congress.gov reported more of {lastName}’s bills than it returned, however the list was read, so
            we aren’t showing an incomplete list or count here.{" "}
            <a href={allUrl} target="_blank" rel="noopener">
              See {lastName}’s bills on Congress.gov ↗
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
    </section>
  );
}
