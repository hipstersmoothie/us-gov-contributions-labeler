// The Bluesky hub: every Bluesky list, grouped, as plain link rows. Rendered
// in full on the server (it works as links without JS); once hydrated, a
// search field filters the rows by name or state code.
import { useEffect, useMemo, useState } from "react";
import { FilterSearch } from "../controls";
import "../../styles/bluesky.css";

export interface ListRowA {
  key: string;
  name: string;
  url: string;
  count: number;
  /** Extra search terms: a state code, a committee id. */
  terms?: string;
}
export interface ListGroup {
  name: string;
  rows: ListRowA[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and");

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export default function BlueskyLists({ groups }: { groups: ListGroup[] }) {
  const [q, setQ] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const needle = norm(q.trim());
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  const shown = useMemo(
    () =>
      groups.map((g) => ({
        ...g,
        rows: g.rows.filter((r) => !needle || norm(r.name).includes(needle) || (r.terms && norm(r.terms).split(" ").includes(needle))),
      })),
    [groups, needle]
  );
  const matches = shown.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="bsky-lists">
      <div className="bsky-lists-search">
        {/* The field only does anything with JS, so it appears once hydrated; the space is held for it. */}
        {ready && <FilterSearch label="Find a list" value={q} onChange={setQ} placeholder="A state, committee or industry" />}
      </div>
      <p className="bsky-lists-status" role="status">
        {needle
          ? matches
            ? `${matches} of ${total} lists match “${q.trim()}”`
            : ""
          : `${total} lists. The number beside each is how many members it follows.`}
      </p>
      {needle && matches === 0 && (
        <p className="bsky-empty">
          No list matches “{q.trim()}”. A state gets a list once two of its members are on Bluesky, and a committee
          once three are, so some have none yet.
        </p>
      )}
      {shown.map((g) => (
        <section key={g.name} className="bsky-group" hidden={g.rows.length === 0} aria-label={g.name}>
          <h4 className="bsky-group-head">
            {g.name}
            {groups.find((x) => x.name === g.name)!.rows.length > 1 && (
              <span>{needle ? `${g.rows.length} of ${groups.find((x) => x.name === g.name)!.rows.length}` : g.rows.length}</span>
            )}
          </h4>
          <ul className={`bsky-rows link-list${groups.find((x) => x.name === g.name)!.rows.length === 1 ? " bsky-rows-one" : ""}`}>
            {g.rows.map((r) => (
              <li key={r.key}>
                <a href={r.url}>
                  <Highlight text={r.name} q={q.trim().toLowerCase()} />
                </a>
                <span className="n">
                  {r.count}
                  <span className="visually-hidden"> members</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
