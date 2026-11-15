import { useMemo } from "react";
import { FilterSearch, FilterSelect, ListTable, Segmented, ShareView, useRows, type ColumnDef } from "./controls";
import { useUrlState } from "./url-state";
import type { BillRow } from "./types";

const PATTERN = { "party-line": "Party line", split: "Split", "near-unanimous": "Near-unanimous" } as const;
const date = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const COLUMNS: ColumnDef<BillRow>[] = [
  {
    id: "name",
    name: "Bill",
    rowHeader: true,
    sort: (r) => r.name,
    cell: (r) => (
      <span>
        <span className="cell-title">{r.name}</span>
        <span className="cell-note">
          {r.label}
          {r.policyArea && ` · ${r.policyArea}`}
        </span>
      </span>
    ),
  },
  { id: "status", name: "Status", wide: true, sort: (r) => (r.law ? "0" : r.status), cell: (r) => r.status },
  {
    id: "vote",
    name: "Latest vote",
    sort: (r) => r.lastVote,
    cell: (r) => (
      <span>
        <span>{date(r.lastVote)}</span>
        <span className="cell-note">{PATTERN[r.pattern]}</span>
      </span>
    ),
  },
  { id: "lobbying", name: "Organizations lobbying", num: true, sort: (r) => r.lobbying, cell: (r) => r.lobbying.toLocaleString() },
];

export default function BillsTable({ initial, policyAreas }: { initial: BillRow[]; policyAreas: string[] }) {
  const { rows } = useRows(initial);
  const [f, set] = useUrlState({ q: "", area: "", pattern: "", sort: "vote", dir: "descending" });
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase().replace(/\./g, "");
    return rows.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q) || r.label.toLowerCase().replace(/\./g, "").includes(q)) &&
        (!f.area || r.policyArea === f.area) &&
        (!f.pattern || r.pattern === f.pattern)
    );
  }, [rows, f.q, f.area, f.pattern]);

  return (
    <div className="list-island">
      <div className="filter-bar">
        <FilterSearch label="Name or number" value={f.q} onChange={(q) => set({ q })} placeholder="GENIUS Act, H.R. 1" />
        <FilterSelect
          label="Policy area"
          value={f.area}
          onChange={(area) => set({ area })}
          options={[{ id: "", label: "All policy areas" }, ...policyAreas.map((a) => ({ id: a, label: a }))]}
        />
        <Segmented
          label="Vote"
          value={f.pattern}
          onChange={(pattern) => set({ pattern })}
          options={[
            { id: "", label: "All" },
            { id: "split", label: "Split" },
            { id: "party-line", label: "Party line" },
            { id: "near-unanimous", label: "Near-unanimous" },
          ]}
        />
        <ShareView />
      </div>
      <ListTable
        label="Bills"
        noun={filtered.length === 1 ? "bill" : "bills"}
        rows={filtered}
        columns={COLUMNS}
        href={(r) => `/bills/${r.id}/`}
        sort={{ column: f.sort, direction: f.dir as "ascending" | "descending" }}
        onSort={(s) => set({ sort: String(s.column), dir: s.direction })}
        resetKey={JSON.stringify(f)}
      />
    </div>
  );
}
