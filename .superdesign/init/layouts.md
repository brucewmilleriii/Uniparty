# Layouts

`app/layout.tsx` is the app shell: a white top header (brand mark with blue/red halves, '119th Congress' tag, lede, party counts), then a two-column grid: a sticky 320px roster rail on the left (`components/RosterRail.tsx`: search, chamber and party segmented buttons, scrolling member list with a party colour bar) and the member file on the right. A plain footer explains data sources. Stacks to one column under 820px.

### `app/layout.tsx`

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import RosterRail, { type RailMember } from "@/components/RosterRail";
import { getRoster } from "@/lib/data";
import { STATES, seatLabel } from "@/lib/format";
import "./globals.css";

export const metadata: Metadata = {
  title: "Uniparty",
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

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap"
        />
      </head>
      <body>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="brand">
              <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
                <rect x="1" y="1" width="24" height="24" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="6" y="6" width="6" height="14" fill="var(--dem)" />
                <rect x="14" y="6" width="6" height="14" fill="var(--rep)" />
              </svg>
              Uniparty
            </Link>
            <span className="tag">119th Congress</span>
            <div className="lede">Look up any member of Congress. Every fact links to its official source.</div>
            <div className="counts">
              <span>
                Senate <b>{count(senate, "R")}R</b> · <b>{count(senate, "D")}D</b> · <b>{count(senate, "I")}I</b>
              </span>
              <span>
                House <b>{count(house, "R")}R</b> · <b>{count(house, "D")}D</b>
                {count(house, "I") ? <> · <b>{count(house, "I")}I</b></> : null}
              </span>
            </div>
          </div>
        </header>
        <main className="wrap">
          <RosterRail members={rail} />
          <section className="file">{children}</section>
        </main>
        <footer>
          <div className="wrap">
            <p>
              <b>Where the data comes from.</b> The roster and committee seats come from the public-domain{" "}
              <a href="https://github.com/unitedstates/congress-legislators" target="_blank" rel="noopener">congress-legislators</a>{" "}
              dataset. Roll-call votes come straight from the House Clerk and Senate.gov. Both are refreshed daily and checked before
              publishing. Bills, campaign money and stock trades will come from Congress.gov, the FEC and STOCK Act filings.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

```

### `components/RosterRail.tsx`

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import type { Chamber, PartyCode } from "@/lib/types";

export interface RailMember {
  id: string;
  name: string;
  lastName: string;
  chamber: Chamber;
  state: string;
  stateName: string;
  seat: string;
  party: PartyCode;
}

export default function RosterRail({ members }: { members: RailMember[] }) {
  const pathname = usePathname();
  const selected = pathname.startsWith("/members/") ? pathname.split("/")[2] : null;
  const [q, setQ] = useState("");
  const [chamber, setChamber] = useState<"" | Chamber>("");
  const [party, setParty] = useState<"" | PartyCode>("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return members.filter((m) => {
      if (chamber && m.chamber !== chamber) return false;
      if (party && m.party !== party) return false;
      if (!needle) return true;
      if (needle.length === 2 && needle === m.state.toLowerCase()) return true;
      return (
        m.name.toLowerCase().includes(needle) ||
        m.stateName.toLowerCase().startsWith(needle) ||
        (m.chamber === "house" && m.seat.toLowerCase() === needle.replace(/\s/g, ""))
      );
    });
  }, [members, q, chamber, party]);

  const seg = <T extends string>(value: T, current: T, set: (v: T) => void, label: string) => (
    <button key={label} type="button" aria-pressed={value === current} onClick={() => set(value)}>
      {label}
    </button>
  );

  return (
    <aside className="rail" aria-label="Members of Congress">
      <div className="controls">
        <label className="seg-label" htmlFor="q">
          Find a member
        </label>
        <input
          id="q"
          className="search"
          type="search"
          placeholder="Name or state, e.g. Warren, TX, CA-17"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="seg" role="group" aria-label="Chamber">
          {seg("", chamber, setChamber, "All")}
          {seg("senate", chamber, setChamber, "Senate")}
          {seg("house", chamber, setChamber, "House")}
        </div>
        <div className="seg" role="group" aria-label="Party">
          {seg("", party, setParty, "Any party")}
          {seg("D", party, setParty, "Dem")}
          {seg("R", party, setParty, "Rep")}
          {seg("I", party, setParty, "Ind")}
        </div>
      </div>
      <div className="list-meta">
        {rows.length === members.length ? `${rows.length} members` : `${rows.length} of ${members.length} members`}
      </div>
      <div className="list" role="list">
        {rows.length ? (
          rows.map((m) => (
            <Link
              key={m.id}
              href={`/members/${m.id}`}
              className="row"
              role="listitem"
              aria-current={m.id === selected ? "true" : undefined}
            >
              <span className={`bar bg-${m.party}`} />
              <span style={{ minWidth: 0 }}>
                <div className="nm">{m.name}</div>
                <div className="sub">
                  {m.chamber === "senate" ? "Senator" : "Representative"} · {m.stateName}
                </div>
              </span>
              <span className="seat">{m.seat}</span>
            </Link>
          ))
        ) : (
          <div className="empty">
            <p>No members match “{q}”. Try a last name or a two-letter state code.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

```

