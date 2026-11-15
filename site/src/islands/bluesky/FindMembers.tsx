// "Find your members": pick a state, see its delegation as Bluesky profile
// cards, with members who aren't on Bluesky listed below so the gap shows.
import { useEffect, useMemo, useState } from "react";
import { FilterSelect, PartyTag } from "../controls";
import { Avatar } from "./Faces";
import type { CardRow, CardLabel } from "./types";

export interface StateOption {
  id: string;
  name: string;
  list?: { url: string; count: number };
}

const fmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const followerText = (n: number) => `${n >= 10_000 ? fmt.format(n) : n.toLocaleString("en-US")} follower${n === 1 ? "" : "s"}`;
const byOrder = (a: CardRow, b: CardRow) => a.district - b.district || a.name.localeCompare(b.name);

export function Pills({ labels, links = false }: { labels: CardLabel[]; links?: boolean }) {
  return (
    <ul className="bsky-pills" aria-label={labels.every((l) => l.k === "s") ? "Top sectors" : "Labels on their posts"}>
      {labels.map((l) => (
        <li key={l.k + l.n}>
          {links && l.h ? (
            <a className={`bsky-pill bsky-pill-${l.k}`} href={l.h}>
              <span className="visually-hidden">{l.k === "s" ? "Sector: " : "Contributor: "}</span>
              {l.n}
            </a>
          ) : (
            <span className={`bsky-pill bsky-pill-${l.k}`}>
              <span className="visually-hidden">{l.k === "s" ? "Sector: " : "Contributor: "}</span>
              {l.n}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Card({ r }: { r: CardRow }) {
  const bsky = `https://bsky.app/profile/${r.handle}`;
  return (
    <li className="bsky-card">
      <a className="bsky-card-face" href={`/members/${r.id}/`} tabIndex={-1} aria-hidden="true">
        <Avatar face={r} size={52} alt="" />
      </a>
      <div className="bsky-card-body">
        <p className="bsky-card-name">
          <PartyTag party={r.party} />
          <a href={`/members/${r.id}/`}>{r.name}</a>
        </p>
        <p className="bsky-card-meta">
          <span>{r.seat}</span>
          {r.followers !== undefined && <span>{followerText(r.followers)}</span>}
        </p>
        <p className="bsky-card-handle">
          <a href={bsky}>@{r.handle}&nbsp;↗</a>
          {r.more ? <span className="muted"> +{r.more} more</span> : null}
        </p>
        {r.labels && r.labels.some((l) => l.k === "s") && <Pills labels={r.labels.filter((l) => l.k === "s")} />}
        {r.labels && r.labels.some((l) => l.k === "c") && (
          <p className="bsky-card-contrib">
            <span className="bsky-card-contrib-k">Top contributors</span>{" "}
            {r.labels
              .filter((l) => l.k === "c")
              .map((l) => l.n)
              .join(" · ")}
          </p>
        )}
      </div>
    </li>
  );
}

/** A state's cards from `${src}${state}.json`, fetched once each. */
function useDelegation(src: string, state: string) {
  const [cache, setCache] = useState<Record<string, CardRow[] | "error">>({});
  useEffect(() => {
    if (!state || cache[state]) return;
    let live = true;
    fetch(`${src}${state}.json`)
      .then((res) => (res.ok ? (res.json() as Promise<CardRow[]>) : Promise.reject(res.status)))
      .then((rows) => live && setCache((c) => ({ ...c, [state]: rows })))
      .catch(() => live && setCache((c) => ({ ...c, [state]: "error" })));
    return () => {
      live = false;
    };
  }, [src, state, cache]);
  const retry = () => setCache(({ [state]: _, ...rest }) => rest);
  return [state ? cache[state] : undefined, retry] as const;
}

export default function FindMembers({ src, states }: { src: string; states: StateOption[] }) {
  const [state, setState] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("state")?.toUpperCase();
    if (q && states.some((s) => s.id === q)) setState(q);
  }, [states]);
  const choose = (id: string) => {
    setState(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set("state", id);
    else url.searchParams.delete("state");
    history.replaceState(null, "", url);
  };

  const info = states.find((s) => s.id === state);
  const [loaded, retry] = useDelegation(src, state);
  const delegation = useMemo(() => (Array.isArray(loaded) ? [...loaded].sort(byOrder) : []), [loaded]);
  const on = delegation.filter((r) => r.handle);
  const off = delegation.filter((r) => !r.handle);

  return (
    <div className="bsky-find">
      <div className="bsky-find-bar">
        <FilterSelect
          label="Your state"
          value={state}
          onChange={choose}
          options={[{ id: "", label: "Choose a state" }, ...states.map((s) => ({ id: s.id, label: s.name }))]}
        />
        {info && Array.isArray(loaded) && (
          <p className="bsky-find-summary" role="status">
            <strong>
              {on.length === 0 ? "None" : on.length} of {info.name}'s {delegation.length} members
            </strong>{" "}
            {on.length === 1 ? "is" : "are"} on Bluesky.
            {info.list && (
              <>
                {" "}
                <a href={info.list.url}>Follow all {info.list.count} in one list&nbsp;↗</a>
              </>
            )}
          </p>
        )}
      </div>

      {!info ? (
        <p className="bsky-find-hint muted">Pick a state to see its senators and representatives on Bluesky, with what our labeler shows on their posts.</p>
      ) : loaded === "error" ? (
        <p className="bsky-find-hint" role="status">
          Couldn't load {info.name}'s members.{" "}
          <button type="button" className="bsky-retry" onClick={retry}>Try again</button> or{" "}
          <a href={`/members/?state=${info.id}`}>see them in the members list</a>.
        </p>
      ) : !loaded ? (
        <p className="bsky-find-hint muted" role="status">Loading {info.name}'s members…</p>
      ) : (
        <>
          {on.length > 0 && (
            <ul className="bsky-cards" aria-label={`${info.name} members on Bluesky`}>
              {on.map((r) => (
                <Card key={r.id} r={r} />
              ))}
            </ul>
          )}
          {off.length > 0 && (
            <div className="bsky-off">
              <h3 className="kicker">Not on Bluesky ({off.length})</h3>
              <ul className="bsky-off-list">
                {off.map((r) => (
                  <li key={r.id}>
                    <PartyTag party={r.party} />
                    <a href={`/members/${r.id}/`}>{r.name}</a> <span className="muted">{r.seat}</span>
                  </li>
                ))}
              </ul>
              <p className="source">
                Know an account we missed?{" "}
                <a href="https://bsky.app/profile/contributions.fyi">Message @contributions.fyi&nbsp;↗</a>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

