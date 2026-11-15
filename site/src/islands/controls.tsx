// React Aria building blocks for the list pages, styled in controls.css
// through React Aria's data attributes. No theme: just the site's tokens.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  Cell,
  Column,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Row,
  SearchField,
  Select,
  SelectValue,
  Table,
  TableBody,
  TableHeader,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  TooltipTrigger,
  type SortDescriptor,
} from "react-aria-components";

// --- filters ----------------------------------------------------------------

export function FilterSearch({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <SearchField className="field search-filter" value={value} onChange={onChange}>
      <Label className="field-label">{label}</Label>
      <div className="field-box">
        <Input className="field-input" placeholder={placeholder} />
        <Button className="field-clear" aria-label="Clear">×</Button>
      </div>
    </SearchField>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <Select className="field select" selectedKey={value} onSelectionChange={(k) => onChange(String(k ?? ""))}>
      <Label className="field-label">{label}</Label>
      <Button className="field-box select-button">
        <SelectValue className="select-value" />
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="chevron">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </Button>
      <Popover className="select-popover" offset={4}>
        <ListBox className="select-list" items={options}>
          {(o) => <ListBoxItem id={o.id} className="select-option">{o.label}</ListBoxItem>}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function Segmented({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: ReactNode; title?: string }[];
}) {
  return (
    <div className="field">
      <span className="field-label" id={`seg-${label}`}>{label}</span>
      <ToggleButtonGroup
        aria-labelledby={`seg-${label}`}
        className="segmented"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[value]}
        onSelectionChange={(keys) => onChange(String([...keys][0] ?? ""))}
      >
        {options.map((o) => (
          <ToggleButton key={o.id} id={o.id} className="segment" aria-label={o.title}>
            {o.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}

/** Copy the current (filtered) URL, with a tooltip explaining the icon button. */
export function ShareView() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard can be blocked; the URL bar still has the link */
    }
  };
  return (
    <TooltipTrigger delay={300}>
      <Button className="icon-button" onPress={copy} aria-label={copied ? "Link copied" : "Copy link to this view"}>
        {copied ? (
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        ) : (
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M8.5 11.5a3.5 3.5 0 005 0l3-3a3.5 3.5 0 00-5-5l-1 1M11.5 8.5a3.5 3.5 0 00-5 0l-3 3a3.5 3.5 0 005 5l1-1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        )}
      </Button>
      <Tooltip className="tooltip" offset={6}>{copied ? "Copied" : "Copy a link to this filtered view"}</Tooltip>
    </TooltipTrigger>
  );
}

// --- table --------------------------------------------------------------------

export interface ColumnDef<T> {
  id: string;
  name: string;
  num?: boolean;
  rowHeader?: boolean;
  /** Hidden below 640px. */
  wide?: boolean;
  sort?: (row: T) => number | string;
  cell: (row: T) => ReactNode;
}

export function ListTable<T extends { id: string }>({
  label,
  noun,
  rows,
  columns,
  href,
  sort,
  onSort,
  pageSize = 100,
  resetKey,
}: {
  label: string;
  noun: string;
  rows: T[];
  columns: ColumnDef<T>[];
  href: (row: T) => string;
  sort: SortDescriptor;
  onSort: (s: SortDescriptor) => void;
  pageSize?: number;
  /** Changes when filters change, to reset paging. */
  resetKey: string;
}) {
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => setLimit(pageSize), [resetKey, pageSize]);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort.column);
    if (!col?.sort) return rows;
    const dir = sort.direction === "descending" ? -1 : 1;
    const key = col.sort;
    return [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [rows, sort, columns]);
  const visible = sorted.slice(0, limit);

  return (
    <>
      <p className="table-status" role="status">
        {rows.length === 0
          ? `No ${noun} match these filters.`
          : `${rows.length.toLocaleString()} ${noun}${visible.length < rows.length ? `, showing the first ${visible.length.toLocaleString()}` : ""}`}
      </p>
      <div className="table-wrap">
        <Table aria-label={label} className="data-table" sortDescriptor={sort} onSortChange={onSort}>
          <TableHeader columns={columns}>
            {(c) => (
              <Column
                id={c.id}
                isRowHeader={c.rowHeader}
                allowsSorting={!!c.sort}
                className={["th", c.num && "num", c.wide && "wide"].filter(Boolean).join(" ")}
              >
                {({ sortDirection, allowsSorting }) => (
                  <span className="th-inner">
                    {c.name}
                    {allowsSorting && (
                      <span className="sort-icon" aria-hidden="true" data-direction={sortDirection ?? undefined}>
                        {sortDirection === "ascending" ? "▲" : sortDirection === "descending" ? "▼" : "↕"}
                      </span>
                    )}
                  </span>
                )}
              </Column>
            )}
          </TableHeader>
          <TableBody items={visible}>
            {(row) => (
              <Row id={row.id} href={href(row)} columns={columns} className="tr">
                {(c) => <Cell className={["td", c.num && "num", c.wide && "wide"].filter(Boolean).join(" ")}>{c.cell(row)}</Cell>}
              </Row>
            )}
          </TableBody>
        </Table>
      </div>
      {visible.length < rows.length && (
        <Button className="more-button" onPress={() => setLimit((l) => l + pageSize)}>
          Show {Math.min(pageSize, rows.length - visible.length).toLocaleString()} more
        </Button>
      )}
    </>
  );
}

/** Rows passed in for the first render, then the full list fetched from `src`. */
export function useRows<T>(initial: T[], src?: string, pick: (json: any) => T[] = (json) => json) {
  const [rows, setRows] = useState(initial);
  const [loading, setLoading] = useState(!!src);
  useEffect(() => {
    if (!src) return;
    fetch(src)
      .then((r) => r.json())
      .then((json) => setRows(pick(json)))
      .finally(() => setLoading(false));
  }, [src]);
  return { rows, loading };
}

export const PARTY_NAME = { D: "Democrat", R: "Republican", I: "Independent" } as const;
export function PartyTag({ party }: { party: "D" | "R" | "I" }) {
  return (
    <span className={`ptag party-${party}`}>
      <span aria-hidden="true">{party}</span>
      <span className="visually-hidden">{PARTY_NAME[party]}</span>
    </span>
  );
}
