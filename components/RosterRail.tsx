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
