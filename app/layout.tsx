import type { Metadata } from "next";
import Link from "next/link";
import Logo from "@/components/Logo";
import RosterRail, { type RailMember } from "@/components/RosterRail";
import { getRoster } from "@/lib/data";
import { STATES, fmtDate, seatLabel } from "@/lib/format";
import { nextElectionDay } from "@/lib/summary";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Uniparty",
  description: "Votes, money, stock trades and bills for every member of Congress, with a source for every fact.",
};

// Re-read the roster at most hourly when it comes from Supabase.
export const revalidate = 3600;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const roster = await getRoster();
  const rail: RailMember[] = roster.members.map((m) => ({
    id: m.bioguideId,
    name: m.name,
    lastName: m.lastName,
    chamber: m.chamber,
    state: m.state,
    stateName: STATES[m.state] ?? m.state,
    seat: seatLabel(m),
    party: m.party,
  }));
  const senate = roster.members.filter((m) => m.chamber === "senate");
  const house = roster.members.filter((m) => m.chamber === "house");
  const count = (list: typeof senate, p: string) => list.filter((m) => m.party === p).length;
  const tally = (list: typeof senate) =>
    (["R", "D", "I"] as const)
      .filter((p) => count(list, p))
      .map((p) => `${count(list, p)} ${p === "I" ? "Ind" : p}`)
      .join(" · ");
  const now = new Date();
  const election = nextElectionDay(now);
  const daysOut = Math.round((election.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Libre+Caslon+Display&family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&display=swap"
        />
      </head>
      <body>
        <header className="mast wrap">
          <div className="dateline">
            <span>119th Congress</span>
            <span className="hide-sm">Every member of Congress, on the record</span>
            <span>
              Roster pulled <time dateTime={roster.fetchedAt}>{fmtDate(roster.fetchedAt)}</time>
            </span>
          </div>
          <div className="ears">
            <div className="ear">
              Senate <b>{tally(senate)}</b>House <b>{tally(house)}</b>
            </div>
            <div className="nameplate">
              <Link href="/" className="brand">
                <Logo size={84} />
                <span>The Uniparty</span>
              </Link>
              <div className="motto">Every member of Congress. Every fact sourced.</div>
            </div>
            <div className="ear">
              Next federal election <b>{fmtDate(election.toISOString())}</b>
              {daysOut === 0 ? "Today" : `${daysOut} ${daysOut === 1 ? "day" : "days"} away`}
            </div>
          </div>
        </header>
        <main className="wrap">
          <RosterRail members={rail} />
          <section className="file">{children}</section>
        </main>
        <footer className="wrap">
          <div className="foot">
            <span className="foot-brand">
              <Logo size={30} />
              The Uniparty
            </span>
            <p>
              <b>Where the data comes from.</b> The roster and committee seats come from the public-domain{" "}
              <a href="https://github.com/unitedstates/congress-legislators" target="_blank" rel="noopener">congress-legislators</a>{" "}
              dataset. Roll-call votes come straight from the House Clerk and Senate.gov, and bills from Congress.gov. Each is refreshed
              on a schedule and checked before publishing. Campaign money and stock trades will come from the FEC and STOCK Act filings.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
