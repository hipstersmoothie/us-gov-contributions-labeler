import { useMemo } from "react";
import { FilterSearch, FilterSelect, ListTable, PartyTag, Segmented, ShareView, type ColumnDef } from "./controls";
import { useUrlState } from "./url-state";
import { moneyAuto } from "../lib/format";
import type { RaceRow } from "./types";

const COLUMNS: ColumnDef<RaceRow>[] = [
  {
    id: "race",
    name: "Race",
    rowHeader: true,
    sort: (r) => r.short,
    cell: (r) => (
      <span>
        <a className="cell-title" href={r.href}>{r.name}</a>
        <span className="cell-note">
          {[r.open ? "Open seat" : "", r.redrawn ? "New district lines" : ""].filter(Boolean).join(" · ") || (r.chamber === "senate" ? "Incumbent running" : r.short)}
        </span>
      </span>
    ),
  },
  {
    id: "field",
    name: "On the ballot",
    wide: true,
    cell: (r) => (
      <span className="race-field">
        {r.field.map((c) => (
          <span key={c.name} className="race-cand">
            {c.party === "D" || c.party === "R" || c.party === "I" ? <PartyTag party={c.party} /> : c.party ? <span className="ptag party-O">{c.party}</span> : null}
            {c.name}
          </span>
        ))}
      </span>
    ),
  },
  { id: "raised", name: "Raised", num: true, sort: (r) => r.raised, cell: (r) => (r.raised ? moneyAuto(r.raised) : "–") },
  { id: "outside", name: "Outside, general", num: true, sort: (r) => r.outside, cell: (r) => (r.outside ? moneyAuto(r.outside) : "–") },
  { id: "result", name: "Result", wide: true, sort: (r) => r.result, cell: (r) => <span className="cell-note">{r.result}</span> },
];

export default function RacesTable({ rows, states }: { rows: RaceRow[]; states: string[] }) {
  const [f, set] = useUrlState({ q: "", chamber: "", state: "", outside: "", seat: "", sort: "outside", dir: "descending" });
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!q || `${r.name} ${r.short} ${r.names}`.toLowerCase().includes(q)) &&
        (!f.chamber || r.chamber === f.chamber) &&
        (!f.state || r.state === f.state) &&
        (!f.outside || r.tier === f.outside || (f.outside === "1m+" && (r.tier === "1m" || r.tier === "10m"))) &&
        (!f.seat || (f.seat === "open" ? r.open : !r.open))
    );
  }, [rows, f.q, f.chamber, f.state, f.outside, f.seat]);

  return (
    <div className="list-island">
      <div className="filter-bar">
        <FilterSearch label="Race or candidate" value={f.q} onChange={(q) => set({ q })} placeholder="e.g. AZ-04 or a name" />
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
          label="Seat"
          value={f.seat}
          onChange={(seat) => set({ seat })}
          options={[
            { id: "", label: "All" },
            { id: "open", label: "Open" },
            { id: "held", label: "Incumbent running", title: "An incumbent on the ballot" },
          ]}
        />
        <FilterSelect
          label="Outside spending"
          value={f.outside}
          onChange={(outside) => set({ outside })}
          options={[
            { id: "", label: "Any amount" },
            { id: "10m", label: "$10M or more" },
            { id: "1m+", label: "$1M or more" },
            { id: "1m", label: "$1M to $10M" },
            { id: "some", label: "Under $1M" },
            { id: "none", label: "None" },
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
        label="2026 House and Senate races"
        noun={filtered.length === 1 ? "race" : "races"}
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
