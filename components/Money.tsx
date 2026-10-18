import Provenance from "@/components/Provenance";
import type { MemberFinanceView } from "@/lib/data";
import { receiptParts } from "@/lib/ingest/finance";
import { cycleLabel, fmtDate, fmtUsd, fmtUsdShort } from "@/lib/format";
import type { CampaignTotals } from "@/lib/types";

const OFFICE = { H: "House", S: "Senate" } as const;

/** A member's campaign money for the cycle: totals, where it came from, and any other campaigns they run. */
export default function Money({ finance, lastName, allUrl }: { finance: MemberFinanceView; lastName: string; allUrl: string }) {
  const cycle = cycleLabel(finance.cycle);
  const [main, ...others] = finance.campaigns ?? [];
  const pulled = finance.fetchedAt !== null;

  return (
    <section className="sec" id="money" aria-labelledby="money-h">
      <h3 className="sec-h" id="money-h">
        Campaign money
        {main && (
          <span>
            {cycle} cycle · reports through {fmtDate(main.coverageEnd)}
          </span>
        )}
      </h3>
      {!pulled ? (
        <p className="panel-note">
          Campaign money hasn’t been pulled from the FEC yet. It appears here after the first daily refresh. Until then,{" "}
          <a href={allUrl} target="_blank" rel="noopener">
            see {lastName}’s filings on fec.gov ↗
          </a>
        </p>
      ) : finance.campaigns === null ? (
        <p className="panel-note">
          The FEC has no candidate record linked to {lastName}, which is usual for members appointed or elected very recently.{" "}
          <a href={allUrl} target="_blank" rel="noopener">
            Search fec.gov ↗
          </a>
        </p>
      ) : !main ? (
        <p className="panel-note">
          {lastName}’s campaign filed no reports with the FEC for the {cycle} cycle.{" "}
          <a href={allUrl} target="_blank" rel="noopener">
            See earlier filings on fec.gov ↗
          </a>
        </p>
      ) : (
        <>
          <Campaign c={main} />
          {others.length > 0 && (
            <p className="panel-note">
              {lastName} also has{" "}
              {others.map((o, i) => (
                <span key={o.candidateId}>
                  {i > 0 && (i === others.length - 1 ? " and " : ", ")}a {OFFICE[o.office]} campaign that raised{" "}
                  <a href={o.pageUrl} target="_blank" rel="noopener">
                    {fmtUsd(o.receipts)} ↗
                  </a>
                </span>
              ))}{" "}
              in the same cycle.
            </p>
          )}
        </>
      )}
      <div className="src">
        <Provenance data={finance} what="Campaign money" />
      </div>
    </section>
  );
}

function Campaign({ c }: { c: CampaignTotals }) {
  const parts = receiptParts(c).filter((p) => p.amount > 0);
  const share = (n: number) => (c.receipts > 0 ? n / c.receipts : 0);
  const pct = (n: number) => {
    const p = share(n) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };

  return (
    <>
      <div className="stats4">
        <div className="stat">
          <div className="k">Raised</div>
          <div className="v">{fmtUsdShort(c.receipts)}</div>
        </div>
        <div className="stat">
          <div className="k">Spent</div>
          <div className="v">{fmtUsdShort(c.disbursements)}</div>
        </div>
        <div className="stat">
          <div className="k">Cash on hand</div>
          <div className="v">{fmtUsdShort(c.cashOnHand)}</div>
        </div>
        <div className="stat">
          <div className="k">Debts</div>
          <div className="v">{fmtUsdShort(c.debts)}</div>
        </div>
      </div>
      <p className="panel-note">
        Totals for the {OFFICE[c.office]} campaign
        {c.electionYear ? ` for the ${c.electionYear} election` : ""}, from {fmtDate(c.coverageStart)} through {fmtDate(c.coverageEnd)}
        {c.lastReport ? `, the ${titleCase(c.lastReport)} report` : ""}. Cash on hand and debts are as of that report.
      </p>
      {parts.length > 0 && (
        <>
          <div className="h4">Where the money came from</div>
          <div className="mbar" aria-hidden="true">
            {parts.map((p) => (
              <i key={p.key} className={`m-${p.key}`} style={{ width: `${share(p.amount) * 100}%` }} />
            ))}
          </div>
          <div className="scroll">
            <table className="money">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Amount</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <span className={`sw m-${p.key}`} aria-hidden="true" />
                      {p.label}
                    </td>
                    <td className="num mono">{fmtUsd(p.amount, true)}</td>
                    <td className="num mono dim">{pct(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total raised</td>
                  <td className="num mono">{fmtUsd(c.receipts, true)}</td>
                  <td className="num mono dim">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
      <p className="panel-note more-note">
        <a href={c.pageUrl} target="_blank" rel="noopener">
          This campaign’s filings, donors and spending on fec.gov ↗
        </a>
      </p>
    </>
  );
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
