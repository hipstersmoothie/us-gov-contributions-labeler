import { useMemo } from "react";
import { FilterSearch, FilterSelect, ListTable, PartyTag, Segmented, ShareView, type ColumnDef } from "./controls";
import { useUrlState } from "./url-state";
import { moneyAuto } from "../lib/format";
import type { MemberRow } from "./types";

const COLUMNS: ColumnDef<MemberRow>[] = [
  {
    id: "name",
    name: "Member",
    rowHeader: true,
    sort: (r) => r.sortName,
    cell: (r) => (
      <span className="cell-name">
        <PartyTag party={r.party} />
        <span>
          <a className="cell-title" href={`/members/${r.id}/`}>{r.name}</a>
          <span className="cell-note">{r.seat}</span>
        </span>
      </span>
    ),
  },
  { id: "sector", name: "Top PAC sector", wide: true, sort: (r) => r.topSector, cell: (r) => r.topSector || "–" },
  { id: "raised", name: "Raised", num: true, sort: (r) => r.raised, cell: (r) => (r.raised ? moneyAuto(r.raised) : "–") },
  { id: "pacs", name: "From PACs", num: true, sort: (r) => r.pacs, cell: (r) => moneyAuto(r.pacs) },
];

export default function MembersTable({ rows, states }: { rows: MemberRow[]; states: string[] }) {
  const [f, set] = useUrlState({ q: "", chamber: "", party: "", state: "", sort: "pacs", dir: "descending" });
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q)) &&
        (!f.chamber || r.chamber === f.chamber) &&
        (!f.party || r.party === f.party) &&
        (!f.state || r.state === f.state)
    );
  }, [rows, f.q, f.chamber, f.party, f.state]);

  return (
    <div className="list-island">
      <div className="filter-bar">
        <FilterSearch label="Name" value={f.q} onChange={(q) => set({ q })} placeholder="Filter by name" />
        <Segmented
          label="Chamber"
          value={f.chamber}
          onChange={(chamber) => set({ chamber })}
          options={[
            { id: "", label: "Both" },
            { id: "house", label: "House" },
            { id: "senate", label: "Senate" },
          ]}
        />
        <Segmented
          label="Party"
          value={f.party}
          onChange={(party) => set({ party })}
          options={[
            { id: "", label: "All" },
            { id: "D", label: <><span className="key party-D" aria-hidden="true" />Dem.</>, title: "Democrats" },
            { id: "R", label: <><span className="key party-R" aria-hidden="true" />Rep.</>, title: "Republicans" },
            { id: "I", label: <><span className="key party-I" aria-hidden="true" />Ind.</>, title: "Independents" },
          ]}
        />
        <FilterSelect
          label="State"
          value={f.state}
          onChange={(state) => set({ state })}
          options={[{ id: "", label: "All states" }, ...states.map((s) => ({ id: s, label: s }))]}
        />
        <ShareView />
      </div>
      <ListTable
        label="Members of Congress"
        noun={filtered.length === 1 ? "member" : "members"}
        rows={filtered}
        columns={COLUMNS}
        sort={{ column: f.sort, direction: f.dir as "ascending" | "descending" }}
        onSort={(s) => set({ sort: String(s.column), dir: s.direction })}
        pageSize={100}
        resetKey={JSON.stringify(f)}
      />
    </div>
  );
}
