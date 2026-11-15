// Every reported House trade, filterable. Amounts are ranges, so
// the amount column sorts by the low end of each range.
import { useMemo } from "react";
import { FilterSearch, ListTable, PartyTag, Segmented, ShareView, useRows, type ColumnDef } from "./controls";
import { useUrlState } from "./url-state";
import type { TradeRow } from "./types";

const date = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const COLUMNS: ColumnDef<TradeRow>[] = [
  {
    id: "member",
    name: "Member",
    rowHeader: true,
    sort: (r) => r.sortName,
    cell: (r) => (
      <span className="cell-name">
        <PartyTag party={r.party} />
        <span className="cell-title">{r.member}</span>
      </span>
    ),
  },
  {
    id: "asset",
    name: "Asset",
    sort: (r) => r.asset,
    cell: (r) => (
      <span>
        <span className="cell-note">{r.tx}</span> {r.asset}
        {r.scanned && <span className="scan-tag" title="Read by machine from a scanned paper form">Scan</span>}
      </span>
    ),
  },
  { id: "owner", name: "Whose", wide: true, sort: (r) => r.owner, cell: (r) => r.owner },
  { id: "date", name: "Traded", num: true, sort: (r) => r.date, cell: (r) => <span className="nowrap">{date(r.date)}</span> },
  { id: "amount", name: "Amount", num: true, sort: (r) => r.min, cell: (r) => r.amount },
  { id: "lag", name: "Reported after", num: true, wide: true, sort: (r) => r.lagDays, cell: (r) => `${r.lagDays} days` },
];

export default function TradesTable({ initial, src }: { initial: TradeRow[]; src: string }) {
  // The JSON carries the § 13107 notice beside its rows.
  const { rows, loading } = useRows(initial, src, (json: { rows: TradeRow[] }) => json.rows);
  const [f, set] = useUrlState({ q: "", owner: "", party: "", kind: "company", sort: "date", dir: "descending" });
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!q || r.member.toLowerCase().includes(q) || r.asset.toLowerCase().includes(q)) &&
        (!f.owner || r.owner === f.owner) &&
        (!f.party || r.party === f.party) &&
        (f.kind !== "company" || r.company)
    );
  }, [rows, f.q, f.owner, f.party, f.kind]);

  return (
    <div className="list-island trades-island">
      <div className="filter-bar">
        <FilterSearch label="Member or asset" value={f.q} onChange={(q) => set({ q })} placeholder="Filter" />
        <Segmented
          label="Asset"
          value={f.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { id: "company", label: "Single companies" },
            { id: "all", label: "Everything" },
          ]}
        />
        <Segmented
          label="Whose"
          value={f.owner}
          onChange={(owner) => set({ owner })}
          options={[
            { id: "", label: "All" },
            { id: "Member", label: "Member" },
            { id: "Spouse", label: "Spouse" },
            { id: "Joint", label: "Joint" },
            { id: "Dependent child", label: "Child" },
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
          ]}
        />
        <ShareView />
      </div>
      <ListTable
        label="Trades reported by House members"
        noun={loading ? "trades so far" : filtered.length === 1 ? "trade" : "trades"}
        rows={filtered}
        columns={COLUMNS}
        href={(r) => `/members/${r.bioguide}/investments/`}
        sort={{ column: f.sort, direction: f.dir as "ascending" | "descending" }}
        onSort={(s) => set({ sort: String(s.column), dir: s.direction })}
        pageSize={25}
        resetKey={JSON.stringify(f)}
      />
    </div>
  );
}
