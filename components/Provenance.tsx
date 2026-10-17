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
