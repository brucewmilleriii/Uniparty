import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Provenance from "@/components/Provenance";
import { getMember, getRoster } from "@/lib/data";
import { PARTY, STATES, ageOn, roleTitle, sourceLinks } from "@/lib/format";

export const revalidate = 3600;

export async function generateStaticParams() {
  const roster = await getRoster();
  return roster.members.map((m) => ({ id: m.bioguideId }));
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { member } = await getMember(id);
  return { title: member ? `${member.name} · Uniparty` : "Member not found · Uniparty" };
}

export default async function MemberPage({ params }: Props) {
  const { id } = await params;
  const { member: m, roster } = await getMember(id);
  if (!m) notFound();

  const L = sourceLinks(m);
  const now = new Date();
  const age = ageOn(m.birthday, now);
  const years = now.getUTCFullYear() - Number(m.servingSince);
  const lead = m.committees.find((c) => c.title && /Chair|Ranking/i.test(c.title));

  return (
    <>
      <div className="card">
        <div className="head">
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">
              <span className={`pill bg-${m.party}`}>{PARTY[m.party]}</span>
              <span>{roleTitle(m)}</span>
            </div>
            <h1>{m.name}</h1>
            <div className="facts">
              <span>
                In the {m.chamber === "senate" ? "Senate" : "House"} since <b>{m.servingSince}</b> ({years} yrs)
              </span>
              <span>
                Term ends <b>Jan {m.termEnd.slice(0, 4)}</b>
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
            </div>
          </div>
          <div className="links">
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
        </div>
      </div>

      <div className="card">
        <div className="panel">
          <div className="h3">Committees</div>
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
          <div className="src">
            <Provenance roster={roster} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="empty">
          <h2>More records for {m.lastName}</h2>
          <p>
            Votes, bills, campaign money and stock trades are being connected next. Until then, these go straight to the official
            record for {STATES[m.state] ?? m.state}’s {m.chamber === "senate" ? "senator" : "representative"}:
          </p>
          <div className="srclinks">
            <a href={L.bills} target="_blank" rel="noopener">
              <b>Bills sponsored ↗</b>
              <span>Congress.gov</span>
            </a>
            <a href={L.fec} target="_blank" rel="noopener">
              <b>Campaign money ↗</b>
              <span>FEC candidate summary</span>
            </a>
            <a href={L.disclosures} target="_blank" rel="noopener">
              <b>Stock trades ↗</b>
              <span>{m.chamber === "house" ? "House Clerk disclosures" : "Senate eFD search"}</span>
            </a>
            <a href={L.votes} target="_blank" rel="noopener">
              <b>Roll-call votes ↗</b>
              <span>{m.chamber === "house" ? "Office of the Clerk" : "Senate.gov"}</span>
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
