import { useMemo } from "react";
import { FilterSearch, ListTable, Segmented, ShareView, useRows, type ColumnDef } from "./controls";
import { useUrlState } from "./url-state";
import { moneyAuto } from "../lib/format";
import type { DonorRow } from "./types";

const COLUMNS: ColumnDef<DonorRow>[] = [
  {
    id: "name",
    name: "Donor",
    rowHeader: true,
    sort: (r) => r.name,
    cell: (r) => (
      <span>
        <a className="cell-title" href={`/donors/${r.id}/`}>{r.name}</a>
        {r.about && <span className="cell-note">{r.about}</span>}
      </span>
    ),
  },
  { id: "top", name: "Biggest recipient", wide: true, sort: (r) => r.top, cell: (r) => r.top || "–" },
  { id: "total", name: "Given", num: true, sort: (r) => r.total, cell: (r) => moneyAuto(r.total) },
];

export default function DonorsTable({ initial, src }: { initial: DonorRow[]; src: string }) {
  const { rows } = useRows(initial, src);
  const [f, set] = useUrlState({ q: "", type: "", sort: "total", dir: "descending" });
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!f.type || r.type === f.type));
  }, [rows, f.q, f.type]);

  return (
    <div className="list-island">
      <div className="filter-bar">
        <FilterSearch label="Name" value={f.q} onChange={(q) => set({ q })} placeholder="Filter by name" />
        <Segmented
          label="Donor type"
          value={f.type}
          onChange={(type) => set({ type })}
          options={[
            { id: "", label: "All" },
            { id: "individual", label: "People" },
            { id: "organization", label: "Organizations" },
            { id: "committee", label: "Committees" },
          ]}
        />
        <ShareView />
      </div>
      <ListTable
        label="Big donors"
        noun={filtered.length === 1 ? "donor" : "donors"}
        rows={filtered}
        columns={COLUMNS}
        sort={{ column: f.sort, direction: f.dir as "ascending" | "descending" }}
        onSort={(s) => set({ sort: String(s.column), dir: s.direction })}
        resetKey={JSON.stringify(f)}
      />
    </div>
  );
}
