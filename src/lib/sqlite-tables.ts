// Turn the JSON data files into SQLite tables, without a schema to keep in
// step with them: every field lands somewhere, so fields added to the data
// later show up in the tables on their own.
//
//   scalars                       columns (camelCase -> snake_case)
//   objects of named fields       columns too, prefixed: places.inState -> places_in_state
//   arrays, and maps keyed by     child tables, named for the path: members.sectors ->
//   ids or years                  members_sectors, linked by the top-level record's key
//                                 (member_bioguide, or its row when it has none), and
//                                 below that by parent_row
//
// Map keys go in a `key` column, or `cycle`/`year` when they're years.
import type { DatabaseSync } from "node:sqlite";

export type Json = string | number | boolean | null | undefined | Json[] | { [k: string]: Json };
type Value = string | number | null;
type Row = Record<string, Value>;

export interface Collection {
  table: string;
  /** Name for the top-level record in its child tables' link column, e.g. "member". */
  singular: string;
  /** The field that identifies a record. Records in a map get their map key here when they lack it. */
  key?: string;
  records: Json[] | Record<string, Json>;
}

/** How a nested array's rows find their way back. */
interface Link {
  column: string;
  value: Value;
  /** The table holding the record that owns the array, below the top level. */
  parent?: string;
}

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();

const isObject = (v: Json): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const scalar = (v: Json): Value =>
  v === undefined || v === null ? null : typeof v === "boolean" ? Number(v) : typeof v === "object" ? JSON.stringify(v) : v;
/** A map rather than a record with named fields: keyed by ids, years or other data. */
const isMap = (o: { [k: string]: Json }) => Object.keys(o).some((k) => !/^[a-z][a-zA-Z]*$/.test(k));
const keyColumn = (field: string, keys: string[]) =>
  keys.length && keys.every((k) => /^(19|20)\d\d$/.test(k)) ? (/year/i.test(field) ? "year" : "cycle") : "key";

export class TableWriter {
  private tables = new Map<string, { columns: Map<string, Set<string>>; rows: Row[] }>();
  /** Tables whose rows other rows point at by `row`. */
  private parents = new Set<string>();

  /** Add a top-level collection and everything under it. */
  add(c: Collection) {
    const entries: [string | undefined, Json][] = Array.isArray(c.records) ? c.records.map((r) => [undefined, r]) : Object.entries(c.records);
    // Records with no key of their own are linked by their row.
    const byRow = !c.key && Array.isArray(c.records);
    if (byRow) this.parents.add(c.table);
    const column = `${c.singular}_${byRow ? "row" : snake(c.key ?? "key")}`;
    for (const [mapKey, record] of entries) {
      const row: Row = {};
      // A map to lists (organization -> bills): a row per item, carrying the map key.
      if (Array.isArray(record)) {
        for (const item of record) {
          const r: Row = { [snake(c.key ?? "key")]: mapKey ?? null };
          if (isObject(item)) this.fill(c.table, r, item, "", { column, value: mapKey ?? null, parent: c.table });
          else r.value = scalar(item);
          this.push(c.table, r);
        }
        continue;
      }
      if (!isObject(record)) {
        this.push(c.table, { [snake(c.key ?? "key")]: mapKey ?? null, value: scalar(record) });
        continue;
      }
      if (mapKey !== undefined && !(c.key && c.key in record)) row[snake(c.key ?? "key")] = mapKey;
      const key = byRow ? this.nextRow(c.table) : c.key && c.key in record ? scalar(record[c.key]) : (mapKey ?? null);
      this.fill(c.table, row, record, "", { column, value: key });
      this.push(c.table, row);
    }
  }

  /** Add one row of named values (anything that isn't a scalar is stored as JSON). */
  addRow(table: string, row: Record<string, Json>) {
    this.push(table, Object.fromEntries(Object.entries(row).map(([k, v]) => [snake(k), scalar(v)])));
  }

  private push(table: string, row: Row) {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = { columns: new Map(), rows: [] }));
    for (const [k, v] of Object.entries(row)) {
      let types = t.columns.get(k);
      if (!types) t.columns.set(k, (types = new Set()));
      if (v !== null) types.add(typeof v === "number" ? (Number.isInteger(v) ? "INTEGER" : "REAL") : "TEXT");
    }
    t.rows.push(row);
  }

  /** The `row` the next row pushed to a table will get. */
  private nextRow(table: string) {
    return (this.tables.get(table)?.rows.length ?? 0) + 1;
  }

  private fill(table: string, row: Row, record: { [k: string]: Json }, prefix: string, link: Link) {
    for (const [field, v] of Object.entries(record)) {
      const column = prefix + snake(field);
      if (v === null || v === undefined) continue;
      if (!isObject(v) && !Array.isArray(v)) row[column] = scalar(v);
      else if (Array.isArray(v) || isMap(v)) this.children(`${table}_${column}`, field, v, table, link);
      else this.fill(table, row, v, `${column}_`, link);
    }
  }

  /** Rows for an array or map. Its owner is the next row pushed to `owner` (records are pushed after their children). */
  private children(table: string, field: string, v: Json[] | { [k: string]: Json }, owner: string, link: Link) {
    const items: [string | undefined, Json][] = Array.isArray(v) ? v.map((x) => [undefined, x]) : Object.entries(v);
    const keyName = Array.isArray(v) ? undefined : keyColumn(field, Object.keys(v));
    const base: Row = { [link.column]: link.value };
    if (link.parent) {
      this.parents.add(owner);
      base.parent_row = this.nextRow(owner);
    }
    for (const [key, item] of items) {
      const row: Row = { ...base };
      if (keyName) row[keyName] = keyName === "key" ? key! : Number(key);
      if (isObject(item) && !isMap(item)) this.fill(table, row, item, "", { ...link, parent: table });
      else row.value = scalar(item);
      this.push(table, row);
    }
  }

  /** Create the tables and write every row. */
  write(db: DatabaseSync) {
    for (const [name, t] of this.tables) {
      const columns = [...t.columns].map(([c, types]) => [c, types.has("TEXT") ? "TEXT" : types.has("REAL") ? "REAL" : types.has("INTEGER") ? "INTEGER" : "TEXT"] as const);
      const row = this.parents.has(name);
      db.exec(`CREATE TABLE "${name}" (${[...(row ? ['"row" INTEGER PRIMARY KEY'] : []), ...columns.map(([c, type]) => `"${c}" ${type}`)].join(", ")})`);
      const names = [...(row ? ["row"] : []), ...columns.map(([c]) => c)];
      const insert = db.prepare(`INSERT INTO "${name}" (${names.map((c) => `"${c}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
      db.exec("BEGIN");
      t.rows.forEach((r, i) => insert.run(...(row ? [i + 1] : []), ...columns.map(([c]) => r[c] ?? null)));
      db.exec("COMMIT");
    }
  }

  get names() {
    return [...this.tables.keys()];
  }
  count(table: string) {
    return this.tables.get(table)?.rows.length ?? 0;
  }
  get rows() {
    return [...this.tables.values()].reduce((n, t) => n + t.rows.length, 0);
  }
}
