import Provenance from "@/components/Provenance";
import { getRoster } from "@/lib/data";

export default async function Home() {
  const roster = await getRoster();
  return (
    <div className="card">
      <div className="welcome">
        <h1>Find your representatives</h1>
        <p>
          Search {roster.members.length} sitting members of Congress by name, state or district. Each profile shows their seat,
          term and committee assignments, with links to the official record for votes, bills, campaign money and stock trades.
        </p>
        <Provenance roster={roster} />
      </div>
    </div>
  );
}
