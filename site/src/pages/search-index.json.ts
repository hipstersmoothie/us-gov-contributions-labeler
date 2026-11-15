// Everything searchable, as compact [label, detail, url] rows.
import { members, organizations, committees, donors, congressCommittees, displayName, seat, kindLabel } from "../lib/data";

export function GET() {
  const rows: [string, string, string][] = [
    ...members.map((m): [string, string, string] => [m.name, `${m.party} · ${seat(m)}`, `/members/${m.bioguide}/`]),
    ...organizations.map((o): [string, string, string] => [o.name, o.industry ?? o.sector, `/organizations/${o.id}/`]),
    ...committees.map((c): [string, string, string] => [displayName(c.name), kindLabel(c.kind), `/pacs/${c.id}/`]),
    ...congressCommittees.map((c): [string, string, string] => [c.name, "Congressional committee", `/committees/${c.id}/`]),
    ...donors.map((d): [string, string, string] => [d.name, d.type === "individual" ? "Big donor" : `Big donor · ${d.type}`, `/donors/${d.id}/`]),
  ];
  return new Response(JSON.stringify(rows));
}
