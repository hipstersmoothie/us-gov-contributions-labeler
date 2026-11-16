// Header search: an autocomplete over the quick index, grouped by type, with
// a link to the full results page. Without JS it's a plain GET form to
// /search/, so it still works.
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ComboBox,
  Header,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  RouterProvider,
  Text,
} from "react-aria-components";
import type { SearchRow } from "../lib/search";
import { group, loadQuick, search } from "./search-core";
import { track } from "../lib/analytics";

const PER_TYPE = 4;

export default function SiteSearch({ initial = "" }: { initial?: string }) {
  const [query, setQuery] = useState(initial);
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () => {
    if (rows || failed) return;
    loadQuick().then(setRows, () => setFailed(true));
  };

  const groups = useMemo(() => (rows ? group(search(rows, query, PER_TYPE)) : []), [rows, query]);
  const allUrl = `/search/?q=${encodeURIComponent(query.trim())}`;

  // "/" focuses search from anywhere, unless the reader is already typing.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      document.getElementById("site-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) location.href = allUrl;
  };

  // Enter with no option highlighted goes to the full results page.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !query.trim()) return;
    const popover = document.querySelector(".search-popover");
    if (popover?.querySelector('[role="option"][data-focused]')) return;
    e.preventDefault();
    location.href = allUrl;
  };

  // Picking a suggestion is a search too: counted by where it leads (a member,
  // an organization…), never by what was typed. "All results" isn't counted
  // here: the results page counts itself.
  const navigate = (href: string) => {
    const section = href.split("/")[1] ?? "";
    if (section !== "search") track("Search", { via: "suggestion", type: section });
    location.href = href;
  };

  return (
    <RouterProvider navigate={navigate}>
      <form className="site-search" action="/search/" role="search" onSubmit={onSubmit}>
        <ComboBox
          inputValue={query}
          onInputChange={(v) => (setQuery(v), load())}
          onFocus={load}
          allowsCustomValue
          menuTrigger="input"
          defaultFilter={() => true}
          allowsEmptyCollection
        >
          <Label className="visually-hidden">Search members, organizations, PACs and donors</Label>
          <div className="search-field">
            <svg className="search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <Input id="site-search" name="q" placeholder="Search members, companies, PACs…" onKeyDown={onKeyDown} />
            <kbd className="search-kbd" aria-hidden="true">/</kbd>
          </div>
          <Popover className="search-popover" placement="bottom end" offset={6}>
            <ListBox
              className="search-list"
              renderEmptyState={() => (
                <p className="search-empty">{failed ? "Search is unavailable right now." : rows ? `No quick matches for “${query}”.` : "Loading…"}</p>
              )}
            >
              {groups.map((g) => (
                <ListBoxSection key={g.type} id={g.type} className="search-section">
                  <Header className="search-header">{g.title}</Header>
                  {g.hits.map((h) => (
                    <ListBoxItem key={h.url} id={h.url} href={h.url} textValue={h.label} className="search-option">
                      <Text slot="label" className="search-label">{h.label}</Text>
                      <Text slot="description" className="search-detail">{h.detail}</Text>
                    </ListBoxItem>
                  ))}
                </ListBoxSection>
              ))}
              {query.trim() && (
                <ListBoxItem id="__all" href={allUrl} textValue={`All results for ${query}`} className="search-option search-all">
                  All results for “{query.trim()}” →
                </ListBoxItem>
              )}
            </ListBox>
          </Popover>
        </ComboBox>
      </form>
    </RouterProvider>
  );
}
