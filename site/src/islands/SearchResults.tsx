// The full results page: every match, in tabs by type.
import { useEffect, useMemo, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type { SearchRow } from "../lib/search";
import { group, search, TYPE_LABEL } from "./search-core";
import { track } from "../lib/analytics";

const LIMIT = 200;

export default function SearchResults() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[] | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get("q")?.trim() ?? "";
    setQuery(q);
    const input = document.getElementById("site-search") as HTMLInputElement | null;
    if (input && q && !input.value) input.value = q;
    fetch("/search-index.json")
      .then((r) => r.json())
      .then(setRows);
  }, []);

  const hits = useMemo(() => (rows ? search(rows, query) : []), [rows, query]);
  const groups = useMemo(() => group(hits), [hits]);

  // One "Search" per submitted query, with how many results it found, in
  // buckets. The query itself is never sent.
  useEffect(() => {
    if (!query || !rows) return;
    track("Search", { via: "results page", results: hits.length === 0 ? "none" : hits.length < 10 ? "1–9" : hits.length < 100 ? "10–99" : "100+" });
  }, [query, rows]);

  if (!query) return <p className="search-summary">Type a name in the search box above.</p>;
  if (!rows) return <p className="search-summary" role="status">Searching…</p>;
  if (!hits.length) return <p className="search-summary" role="status">No results for “{query}”.</p>;

  const list = (items: typeof hits) => (
    <ol className="results">
      {items.slice(0, LIMIT).map((h) => (
        <li key={h.url}>
          <a href={h.url}>{h.label}</a>
          <span className="result-detail">{h.detail}</span>
        </li>
      ))}
      {items.length > LIMIT && <li className="result-more">and {(items.length - LIMIT).toLocaleString()} more. Try a longer search.</li>}
    </ol>
  );

  return (
    <>
      <p className="search-summary" role="status">
        {hits.length.toLocaleString()} {hits.length === 1 ? "result" : "results"} for “{query}”
      </p>
      <Tabs className="tabs">
        <TabList aria-label="Result types" className="tab-list">
          <Tab id="all" className="tab">All <span className="tab-count">{hits.length.toLocaleString()}</span></Tab>
          {groups.map((g) => (
            <Tab key={g.type} id={g.type} className="tab">
              {TYPE_LABEL[g.type].replace("Congressional committees", "Committees").replace("PACs and outside groups", "PACs")}{" "}
              <span className="tab-count">{g.hits.length.toLocaleString()}</span>
            </Tab>
          ))}
        </TabList>
        <TabPanel id="all" className="tab-panel">
          {groups.map((g) => (
            <section key={g.type} className="result-group">
              <h2 className="kicker">{g.title}</h2>
              {list(g.hits.slice(0, 8))}
            </section>
          ))}
        </TabPanel>
        {groups.map((g) => (
          <TabPanel key={g.type} id={g.type} className="tab-panel">
            {list(g.hits)}
          </TabPanel>
        ))}
      </Tabs>
    </>
  );
}
