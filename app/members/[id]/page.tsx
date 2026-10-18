import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Bills from "@/components/Bills";
import Money from "@/components/Money";
import Provenance from "@/components/Provenance";
import Record from "@/components/Record";
import RecentVotes from "@/components/RecentVotes";
import { getMember, getMemberBills, getMemberFinance, getMemberVotes, getRoster } from "@/lib/data";
import { PARTY, STATES, ageOn, cycleLabel, fmtDate, fmtUsd, fmtUsdShort, roleTitle, sourceLinks } from "@/lib/format";
import { summarizeVotes } from "@/lib/summary";

export const revalidate = 3600;

export async function generateStaticParams() {
  const roster = await getRoster();
  return roster.members.map((m) => ({ id: m.bioguideId }));
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { member } = await getMember(id);
  return { title: member ? `${member.name} · The Uniparty` : "Member not found · The Uniparty" };
}

export default async function MemberPage({ params }: Props) {
  const { id } = await params;
  const { member: m, roster } = await getMember(id);
  if (!m) notFound();
  const [votes, bills, finance] = await Promise.all([getMemberVotes(m), getMemberBills(m), getMemberFinance(m)]);
  const money = finance.campaigns?.[0];

  const L = sourceLinks(m);
  const now = new Date();
  const age = ageOn(m.birthday, now);
  const years = now.getUTCFullYear() - Number(m.servingSince);
  const lead = m.committees.find((c) => c.title && /Chair|Ranking/i.test(c.title));
  const chamber = m.chamber === "senate" ? "Senate" : "House";
  const role = m.chamber === "senate" ? "senator" : "representative";
  const s = summarizeVotes(votes.rows);
  const partyPct = s.comparable ? Math.round((s.withParty / s.comparable) * 100) : null;

  const numbers: { v: string; k: string }[] = [{ v: String(years), k: `Years in the ${chamber}` }];
  if (partyPct !== null) numbers.push({ v: `${partyPct}%`, k: "Votes with their party" });
  if (s.total) numbers.push({ v: String(s.missed), k: `Roll calls missed of ${s.total}` });
  if (bills.sponsoredCount !== null) numbers.push({ v: bills.sponsoredCount.toLocaleString("en-US"), k: "Bills sponsored this Congress" });
  if (bills.cosponsoredCount !== null) numbers.push({ v: bills.cosponsoredCount.toLocaleString("en-US"), k: "Bills cosponsored" });
  if (money) numbers.push({ v: fmtUsdShort(money.receipts), k: `Raised in ${cycleLabel(money.cycle)}` });

  return (
    <>
      <article className="lead" aria-labelledby="member-name">
        <div className="kicker">
          U.S. {chamber} · {roleTitle(m)}
        </div>
        <h1 id="member-name">{m.name}</h1>
        <p className="dek">
          {m.partyName} {role} for {STATES[m.state] ?? m.state}, in the {chamber} since {m.servingSince}. The current term ends in January{" "}
          {m.termEnd.slice(0, 4)}.
        </p>
        <div className="byline">
          <span className={`pill bg-${m.party}`}>{PARTY[m.party]}</span>
          <span>
            Serving <b>{years} yrs</b>
          </span>
          {age !== null && (
            <span>
              Age <b>{age}</b>
            </span>
          )}
          {m.phone && (
            <span>
              Office <b className="mono">{m.phone}</b>
            </span>
          )}
          {lead && (
            <span>
              {lead.title}, <b>{lead.name}</b>
            </span>
          )}
          {m.website && (
            <a href={m.website} target="_blank" rel="noopener">
              Official site ↗
            </a>
          )}
          <a href={L.bio} target="_blank" rel="noopener">
            Congressional bio ↗
          </a>
          <a href={L.fec} target="_blank" rel="noopener">
            FEC filings ↗
          </a>
        </div>
        {s.total > 0 && (
          <div className="cols">
            <p>
              {m.lastName} voted Yea or Nay on {s.cast} of the {chamber}’s last {s.total} roll calls they were eligible for
              {s.missed ? `, missed ${s.missed}` : ""}
              {s.present ? ` and answered “present” ${s.present === 1 ? "once" : `${s.present} times`}` : ""}.
              {partyPct !== null &&
                ` When they voted, they sided with most ${m.partyName}s ${s.withParty} of ${s.comparable} times.`}
            </p>
            {bills.sponsoredCount !== null && (
              <p>
                In the current Congress they have sponsored {bills.sponsoredCount.toLocaleString("en-US")} bills and resolutions and
                cosponsored {(bills.cosponsoredCount ?? 0).toLocaleString("en-US")}.
              </p>
            )}
            {money && money.receipts > 0 && (
              <p>
                Their {money.office === "S" ? "Senate" : "House"} campaign raised {fmtUsd(money.receipts)} in the {cycleLabel(money.cycle)} cycle
                through {fmtDate(money.coverageEnd)}, {Math.round(((money.individualItemized + money.individualUnitemized) / (money.receipts || 1)) * 100)}% of
                it from individual donors, and had {fmtUsd(money.cashOnHand)} on hand.
              </p>
            )}
          </div>
        )}
        <Provenance data={roster} />
      </article>

      {numbers.length > 1 && (
        <section className="numbers" aria-label="By the numbers">
          {numbers.map((n) => (
            <div key={n.k}>
              <b>{n.v}</b>
              <span>{n.k}</span>
            </div>
          ))}
        </section>
      )}

      <Record votes={votes} summary={s} lastName={m.lastName} partyName={m.partyName} />

      <RecentVotes votes={votes} lastName={m.lastName} />

      <Bills bills={bills} lastName={m.lastName} allUrl={L.bills} />

      <Money finance={finance} lastName={m.lastName} allUrl={L.fec} />

      <section className="sec" aria-labelledby="more-h">
        <div className="three">
          <div>
            <h3 className="sec-h" id="more-h">
              Committees
            </h3>
            {m.committees.length ? (
              <ul className="cmte">
                {m.committees.map((c) => (
                  <li key={c.committeeId}>
                    <span>{c.name}</span>
                    {c.title && <span className="role">{c.title}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="panel-note">No committee assignments on file.</p>
            )}
          </div>
          <div>
            <h3 className="sec-h">Trades and filings</h3>
            <p className="panel-note">
              Stock trades are being connected next. Until then, these go straight to the official record for {STATES[m.state] ?? m.state}’s {role}:
            </p>
            <ul className="srclinks">
              <li>
                <a href={L.fec} target="_blank" rel="noopener">
                  Every FEC filing ↗
                </a>
                <span>FEC candidate page</span>
              </li>
              <li>
                <a href={L.disclosures} target="_blank" rel="noopener">
                  Stock trades ↗
                </a>
                <span>{m.chamber === "house" ? "House Clerk disclosures" : "Senate eFD search"}</span>
              </li>
              <li>
                <a href={L.votes} target="_blank" rel="noopener">
                  Full voting record ↗
                </a>
                <span>{m.chamber === "house" ? "Office of the Clerk" : "Senate.gov"}</span>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="sec-h">Contact the office</h3>
            <p className="contact">
              {m.office && (
                <>
                  {m.office}
                  <br />
                </>
              )}
              {m.phone && (
                <>
                  <span className="mono">{m.phone}</span>
                  <br />
                </>
              )}
              {m.website && (
                <a href={m.website} target="_blank" rel="noopener">
                  {m.website.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
                </a>
              )}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
