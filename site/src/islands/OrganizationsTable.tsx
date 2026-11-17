import { useMemo } from "react";
import { FilterSearch, FilterSelect, ListTable, ShareView, useRows, type ColumnDef } from "./controls";
import { useUrlState } from "./url-state";
import { moneyAuto } from "../lib/format";
import type { OrgRow } from "./types";

const COLUMNS: ColumnDef<OrgRow>[] = [
  {
    id: "name",
    name: "Organization",
    rowHeader: true,
    sort: (r) => r.name,
    cell: (r) => (
      <span>
        <a className="cell-title" href={`/organizations/${r.id}/`}>{r.name}</a>
        {r.industry && <span className="cell-note">{r.industry}</span>}
      </span>
    ),
  },
  { id: "sector", name: "Sector", wide: true, sort: (r) => r.sector, cell: (r) => r.sector },
  { id: "members", name: "Members funded", num: true, wide: true, sort: (r) => r.members, cell: (r) => r.members.toLocaleString() },
  { id: "total", name: "Given", num: true, sort: (r) => r.total, cell: (r) => moneyAuto(r.total) },
];

export default function OrganizationsTable({ initial, src, sectors }: { initial: OrgRow[]; src: string; sectors: string[] }) {
  const { rows } = useRows(initial, src);
  const [f, set] = useUrlState({ q: "", sector: "", sort: "total", dir: "descending" });
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!f.sector || r.sector === f.sector));
  }, [rows, f.q, f.sector]);

  return (
    <div className="list-island">
      <div className="filter-bar">
        <FilterSearch label="Name" value={f.q} onChange={(q) => set({ q })} placeholder="Filter by name" />
        <FilterSelect
          label="Sector"
          value={f.sector}
          onChange={(sector) => set({ sector })}
          options={[{ id: "", label: "All sectors" }, ...sectors.map((s) => ({ id: s, label: s }))]}
        />
        <ShareView />
      </div>
      <ListTable
        label="Organizations"
        noun={filtered.length === 1 ? "organization" : "organizations"}
        rows={filtered}
        columns={COLUMNS}
        sort={{ column: f.sort, direction: f.dir as "ascending" | "descending" }}
        onSort={(s) => set({ sort: String(s.column), dir: s.direction })}
        resetKey={JSON.stringify(f)}
      />
    </div>
  );
}
