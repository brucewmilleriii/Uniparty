import { fmtDate } from "@/lib/format";
import type { Roster } from "@/lib/data";

/** The "where this came from and when" line shown under every dataset. */
export default function Provenance({ roster, what = "Roster and committees" }: { roster: Roster; what?: string }) {
  return (
    <div className="prov">
      <span className="ok" aria-hidden="true" />
      <span>
        {what} from <a href={roster.sourceHome} target="_blank" rel="noopener">{roster.source}</a>
      </span>
      <span>
        Pulled <time dateTime={roster.fetchedAt}>{fmtDate(roster.fetchedAt)}</time> · checked daily
      </span>
    </div>
  );
}
