// "Find your member of Congress": by ZIP code, from the build's ZIP table,
// or by street address, through the Census Geocoder (site/server/src/geocode.ts).
//
// A ZIP can cross district lines, so a ZIP lookup shows every district it
// touches with the share of its land in each, and offers the address lookup
// to settle it. Addresses go in a POST body to our server and on to the
// Census Bureau, never into a URL, a log or analytics; if the geocoder is
// down, the finder falls back to the ZIP.
//
// Before hydration this is a plain GET form to /find/?zip=, so a ZIP typed
// in early still works.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, FieldError, Form, Input, Label, TextField, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { money } from "../../lib/format";
import { track } from "../../lib/analytics";
import type { DelegationFile, MemberSummary, OutsideSpender } from "./types";
import { capitalize, districtName, loadDelegation, lookupAddress, lookupZip, placeName, possessive, shortDistrict, type Part } from "./core";

type Mode = "zip" | "address";

interface Result {
  via: Mode;
  /** What was looked up: "ZIP 85004", or the address as the Census matched it. */
  subject: string;
  /** Districts the reader may be in, most likely first, and slivers of the ZIP under 1%. */
  parts: Part[];
  slivers: Part[];
  /** For senators and names; one state almost always. */
  states: DelegationFile[];
  /** The reader's representative isn't known, only their state (an unmapped ZIP). */
  stateOnly?: boolean;
  /** Something to say first: the geocoder was down, the ZIP isn't on the map. */
  notice?: ReactNode;
  /** A link that reproduces this result without the address. */
  share?: string;
}

const SLIVER = 0.01;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

export default function Finder({
  congress,
  congressLabel,
  cycleRange,
  syncUrl = false,
  size = "page",
}: {
  congress: number;
  /** "119th Congress (2025–2027)" */
  congressLabel: string;
  /** "2021–2026", the span the money figures cover. */
  cycleRange: string;
  /** On /find/: read ?zip= and ?district= on load, and keep them in the URL. */
  syncUrl?: boolean;
  size?: "page" | "home";
}) {
  const [mode, setMode] = useState<Mode>("zip");
  const [zip, setZip] = useState("");
  const [street, setStreet] = useState("");
  const [addrZip, setAddrZip] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const streetRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const setUrl = (params: Record<string, string> | null) => {
    if (!syncUrl) return;
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    history.replaceState(null, "", `${location.pathname}${qs}`);
  };

  async function show(r: Omit<Result, "states">, stateCodes: string[]) {
    const states = await Promise.all([...new Set(stateCodes)].map(loadDelegation));
    setResult({ ...r, states });
    setError(null);
  }

  async function byZip(raw: string, notice?: ReactNode, via: Mode = "zip") {
    const z = raw.trim().slice(0, 5);
    const answer = await lookupZip(congress, z);
    if (answer.kind === "districts") {
      const parts = answer.parts.filter((p) => p.share === undefined || p.share >= SLIVER);
      const slivers = answer.parts.filter((p) => p.share !== undefined && p.share < SLIVER);
      await show({ via, subject: `ZIP ${z}`, parts, slivers, notice, share: `/find/?zip=${z}` }, answer.parts.map((p) => p.state));
      if (via === "zip") setUrl({ zip: z });
      return true;
    }
    if (answer.kind === "unmapped") {
      // A state with one House seat (an at-large state, DC, a territory) needs no map.
      const states = await Promise.all(answer.states.map(loadDelegation));
      const seats = states.map((s) => Object.keys(s.house));
      if (states.length === 1 && seats[0]!.length === 1) {
        setResult({ via, subject: `ZIP ${z}`, parts: [{ state: states[0]!.state, district: Number(seats[0]![0]) }], slivers: [], states, notice, share: `/find/?zip=${z}` });
        setError(null);
        if (via === "zip") setUrl({ zip: z });
        return true;
      }
      await show(
        {
          via,
          subject: `ZIP ${z}`,
          parts: [],
          slivers: [],
          stateOnly: true,
          notice: notice ?? (
            <>
              ZIP {z} isn't on the Census Bureau's ZIP map, which leaves out most PO box and single-business ZIPs. Enter
              your street address to find your representative.
            </>
          ),
        },
        answer.states
      );
      if (via === "zip") setUrl({ zip: z });
      return false;
    }
    setResult(null);
    setError(
      answer.kind === "military" ? (
        <>Military mail ZIPs (APO, FPO and DPO) aren't tied to a district. Try the ZIP or address of your home in the States.</>
      ) : (
        <>We couldn't find ZIP {z}. Check the number, or look up your street address instead.</>
      )
    );
    return false;
  }

  async function byAddress(streetLine: string, z: string) {
    const answer = await lookupAddress(congress, `${streetLine}, ${z}`);
    if (answer.status === "match") {
      await show(
        { via: "address", subject: answer.matched, parts: [{ state: answer.state, district: answer.district }], slivers: [], share: `/find/?district=${answer.state}-${answer.district}` },
        [answer.state]
      );
      setUrl({ district: `${answer.state}-${answer.district}` });
      return { found: true };
    }
    const fallback =
      answer.status === "nomatch" ? (
        <>The Census Bureau couldn't match that street address, so this is what ZIP {z.slice(0, 5)} tells us. Check the spelling and try again for an exact answer.</>
      ) : answer.status === "limited" ? (
        <>That's a lot of address lookups in a short time, so for now this is what ZIP {z.slice(0, 5)} tells us. Try the address again in a few minutes.</>
      ) : (
        <>The Census Bureau's address lookup isn't responding, so this is what ZIP {z.slice(0, 5)} tells us. Try the address again later for an exact answer.</>
      );
    const found = await byZip(z, fallback, "address");
    return { found, down: answer.status !== "nomatch" };
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch {
      setResult(null);
      setError(<>Something went wrong loading the district data. Check your connection and try again.</>);
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (mode === "zip") {
      if (!ZIP_RE.test(zip.trim())) return;
      void run(async () => {
        const found = await byZip(zip);
        track("Find member", { via: "zip", found: found ? "yes" : "no" });
      });
    } else {
      if (!street.trim() || !ZIP_RE.test(addrZip.trim())) return;
      void run(async () => {
        const { found, down } = await byAddress(street.trim(), addrZip.trim());
        track("Find member", { via: "address", found: found ? "yes" : "no", ...(down ? { geocoder: "down" } : {}) });
      });
    }
  };

  // ?zip= and ?district= on /find/: a shared link.
  useEffect(() => {
    if (!syncUrl) return;
    const params = new URLSearchParams(location.search);
    const z = params.get("zip");
    const d = params.get("district")?.toUpperCase().match(/^([A-Z]{2})-(\d{1,2})$/);
    if (z && ZIP_RE.test(z)) {
      setZip(z);
      void run(async () => void (await byZip(z)));
    } else if (d) {
      void run(() => show({ via: "address", subject: "", parts: [{ state: d[1]!, district: Number(d[2]) }], slivers: [], share: `/find/?district=${d[1]}-${Number(d[2])}` }, [d[1]!]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const narrow = () => {
    setMode("address");
    if (!addrZip && result?.subject.startsWith("ZIP ")) setAddrZip(result.subject.slice(4));
    setTimeout(() => streetRef.current?.focus(), 0);
  };

  return (
    <div className={`finder finder-${size}`}>
      <Form className="finder-form" action="/find/" method="get" onSubmit={onSubmit} aria-label="Find your member of Congress">
        <div className="finder-modes">
          <span className="field-label" id="finder-mode-label">Look up by</span>
          <ToggleButtonGroup
            aria-labelledby="finder-mode-label"
            className="segmented"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[mode]}
            onSelectionChange={(keys) => setMode(([...keys][0] as Mode) ?? "zip")}
          >
            <ToggleButton id="zip" className="segment">ZIP code</ToggleButton>
            <ToggleButton id="address" className="segment">Street address</ToggleButton>
          </ToggleButtonGroup>
        </div>
        <div className="finder-fields">
          {mode === "zip" ? (
            <TextField
              className="field finder-zip"
              value={zip}
              onChange={setZip}
              name="zip"
              isRequired
              validate={(v) => (v && !ZIP_RE.test(v.trim()) ? "Enter a five-digit ZIP code." : null)}
            >
              <Label className="field-label">ZIP code</Label>
              <Input className="field-box field-input" inputMode="numeric" autoComplete="postal-code" maxLength={10} placeholder="e.g. 85004" />
              <FieldError className="field-error" />
            </TextField>
          ) : (
            <>
              <TextField className="field finder-street" value={street} onChange={setStreet} isRequired>
                <Label className="field-label">Street address</Label>
                <Input ref={streetRef} className="field-box field-input" autoComplete="address-line1" placeholder="e.g. 1 E Washington St" />
                <FieldError className="field-error" />
              </TextField>
              <TextField
                className="field finder-zip"
                value={addrZip}
                onChange={setAddrZip}
                isRequired
                validate={(v) => (v && !ZIP_RE.test(v.trim()) ? "Enter a five-digit ZIP code." : null)}
              >
                <Label className="field-label">ZIP code</Label>
                <Input className="field-box field-input" inputMode="numeric" autoComplete="postal-code" maxLength={10} />
                <FieldError className="field-error" />
              </TextField>
            </>
          )}
          <Button type="submit" className="finder-submit" isDisabled={busy}>
            {busy ? "Finding…" : "Find my members"}
          </Button>
        </div>
        <p className="finder-privacy">
          Addresses go only to the Census Bureau's geocoder to find the district; we never log, store or link to them.
        </p>
      </Form>

      <div className="find-results" ref={resultsRef} aria-live="polite" aria-busy={busy}>
        {error && <p className="find-error">{error}</p>}
        {result && <Results r={result} onNarrow={narrow} congressLabel={congressLabel} cycleRange={cycleRange} showShare={!syncUrl} />}
      </div>
    </div>
  );
}

function Results({ r, onNarrow, congressLabel, cycleRange, showShare }: { r: Result; onNarrow: () => void; congressLabel: string; cycleRange: string; showShare: boolean }) {
  const byState = new Map(r.states.map((s) => [s.state, s]));
  const nameOf = (p: Part) => districtName(p.state, byState.get(p.state)?.name ?? p.state, p.district);
  const split = r.parts.length > 1;
  const one = r.parts[0];
  const multiState = r.states.length > 1;

  let headline: ReactNode;
  if (r.stateOnly) headline = <>{r.subject} is in {listOf(r.states.map((s) => placeName(s.state, s.name)))}.</>;
  else if (!split && one) headline = r.subject ? <>{r.via === "address" ? <span className="find-address">{r.subject}</span> : r.subject} is in <strong>{nameOf(one)}</strong>.</> : <><strong>{capitalize(nameOf(one))}</strong></>;
  else headline = <>{r.subject} crosses <strong>{r.parts.length} congressional districts</strong>.</>;

  return (
    <section className="find-result" aria-label="Your members of Congress">
      {r.notice && <p className="find-notice">{r.notice}</p>}
      <p className="find-headline">{headline}</p>
      {split && (
        <div className="find-narrow">
          <p>Your representative is one of these {r.parts.length}. Your street address will say which.</p>
          <Button className="finder-submit finder-secondary" onPress={onNarrow}>Look up my address</Button>
        </div>
      )}

      {r.parts.length > 0 && (
        <>
          <h3 className="find-group">{split ? "Your representative is one of" : r.parts[0] && byState.get(r.parts[0].state)?.noSenators ? "Your member of Congress" : "Your representative"}</h3>
          <div className="mcards">
            {r.parts.map((p) => {
              const m = byState.get(p.state)?.house[String(p.district)];
              const where = shortDistrict(p.state, p.district);
              const note =
                p.share !== undefined && split ? (
                  <p className="mcard-share">
                    <span className="share-bar" style={{ ["--w" as string]: p.share }} aria-hidden="true" />
                    {sharePhrase(p.share)} of the ZIP's area is in {multiState ? nameOf(p) : `district ${p.district}`}
                  </p>
                ) : null;
              return m ? <MemberCard key={where} m={m} note={note} where={multiState ? byState.get(p.state)?.name : undefined} /> : <VacantCard key={where} name={nameOf(p)} note={note} />;
            })}
          </div>
          {r.slivers.length > 0 && (
            <p className="find-sliver">
              The ZIP's edge also touches{" "}
              {listOf(r.slivers.map((p) => {
                const m = byState.get(p.state)?.house[String(p.district)];
                return `${shortDistrict(p.state, p.district)}${m ? ` (${m.name})` : ""}`;
              }))}
              , under 1% of its area.
            </p>
          )}
        </>
      )}

      {r.states.map((s) =>
        s.noSenators ? (
          <p key={s.state} className="find-note">
            {capitalize(placeName(s.state, s.name))} has no senators, and {s.state === "PR" ? "its resident commissioner" : "its delegate"} can't vote on the final passage of bills.
          </p>
        ) : (
          <div key={s.state}>
            <h3 className="find-group">{multiState || r.stateOnly ? `${possessive(s.state, s.name)} senators` : "Your senators"}</h3>
            <div className="mcards">
              {s.senators.map((m) => <MemberCard key={m.id} m={m} />)}
            </div>
          </div>
        )
      )}

      <Outside
        members={[
          ...r.parts.flatMap((p) => {
            const m = byState.get(p.state)?.house[String(p.district)];
            return m ? [m] : [];
          }),
          ...r.states.flatMap((s) => s.senators),
        ]}
        split={split}
        cycleRange={cycleRange}
      />

      <p className="find-links">
        {r.states.map((s, i) => (
          <span key={s.state}>
            {i > 0 && " · "}
            <a href={`/states/${s.state.toLowerCase()}/`}>{capitalize(r.stateOnly ? `all of ${possessive(s.state, s.name)} members` : `${possessive(s.state, s.name)} whole delegation`)}</a>
          </span>
        ))}
        {showShare && r.share && (
          <>
            {" · "}
            <a href={r.share}>Link to this result</a>
          </>
        )}
      </p>
      <p className="find-map-note">Districts as drawn for the {congressLabel}, the ones current members were elected to represent.</p>
    </section>
  );
}

const SPENDERS_SHOWN = 8;

/** Who's spending on the reader's races: outside groups' spending that named their members. */
function Outside({ members, split, cycleRange }: { members: MemberSummary[]; split: boolean; cycleRange: string }) {
  const surname = (name: string) => name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)!;
  const rows: (OutsideSpender & { m: MemberSummary })[] = members.flatMap((m) => (m.outside?.spenders ?? []).map((x) => ({ ...x, m })));
  rows.sort((a, b) => b.support + b.oppose - (a.support + a.oppose));
  const support = members.reduce((t, m) => t + (m.outside?.support ?? 0), 0);
  const oppose = members.reduce((t, m) => t + (m.outside?.oppose ?? 0), 0);
  const opponents = members.filter((m) => (m.outside?.opponents.support ?? 0) + (m.outside?.opponents.oppose ?? 0) > 0);
  const who = split ? "these members" : members.length === 1 ? "your member" : "your members";
  return (
    <section className="find-outside" aria-labelledby="find-outside-h">
      <h3 className="find-group" id="find-outside-h">Outside money in {split ? "these races" : "your races"}</h3>
      {rows.length === 0 ? (
        <p className="find-note">No outside groups reported spending for or against {who} by name, {cycleRange}.</p>
      ) : (
        <>
          <p className="find-dek">
            Super PACs and other groups can spend without limit for or against a candidate, as long as they don't coordinate
            with the campaign. From {cycleRange.replace("–", " to ")}, they spent <strong>{money(support, true)}</strong> supporting{" "}
            {who} and <strong>{money(oppose, true)}</strong> opposing them.
          </p>
          <table className="find-outside-table">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col" className="num">Supporting</th>
                <th scope="col" className="num">Opposing</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, SPENDERS_SHOWN).map((x) => (
                <tr key={`${x.id}-${x.m.id}`}>
                  <td>
                    <a href={x.href}>{x.name}</a>
                    <span className="find-outside-note">
                      {x.kind ? `${x.kind} · ` : ""}on <span className={`ptag party-${x.m.party}`} aria-hidden="true">{x.m.party}</span>{surname(x.m.name)}
                    </span>
                  </td>
                  <td className="num">{x.support ? money(x.support, true) : <span className="muted">–</span>}</td>
                  <td className="num">{x.oppose ? money(x.oppose, true) : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {opponents.length > 0 && (
        <p className="find-note">
          Groups also spent on their opponents' campaigns, counted apart:{" "}
          {opponents.map((m, i) => (
            <span key={m.id}>
              {i > 0 && "; "}
              <a href={`/members/${m.id}/#outside`}>{surname(m.name)}{surname(m.name).endsWith("s") ? "'" : "'s"} opponents</a>, {money(m.outside!.opponents.support, true)} supporting and {money(m.outside!.opponents.oppose, true)} opposing
            </span>
          ))}
          .
        </p>
      )}
      <p className="find-note">Each group's page shows who funds it, where its filings say.</p>
    </section>
  );
}

export function MemberCard({ m, note, where }: { m: MemberSummary; note?: ReactNode; where?: string }) {
  const initials = `${m.name[0] ?? ""}${m.name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)?.[0] ?? ""}`;
  return (
    <article className="mcard">
      {m.photo ? (
        <img className="mcard-photo" src={m.photo} alt="" width={64} height={78} loading="lazy" decoding="async" />
      ) : (
        <span className="mcard-photo mcard-initials" aria-hidden="true">{initials}</span>
      )}
      <div className="mcard-body">
        <p className="mcard-seat">
          <span className={`ptag party-${m.party}`} aria-hidden="true">{m.party}</span>
          {m.partyName} · {where ? `${where}, ` : ""}{m.seat}
        </p>
        <p className="mcard-name"><a href={`/members/${m.id}/`}>{m.name}</a></p>
        <p className="mcard-money">
          <strong>{money(m.pac, true)}</strong> from PACs{m.raised > 0 && <> · {money(m.raised, true)} raised</>}
        </p>
        {m.industries.length > 0 && <p className="mcard-top">Top industries: {m.industries.join(", ")}</p>}
        {note}
      </div>
    </article>
  );
}

function VacantCard({ name, note }: { name: string; note?: ReactNode }) {
  return (
    <article className="mcard mcard-vacant">
      <span className="mcard-photo mcard-initials" aria-hidden="true">–</span>
      <div className="mcard-body">
        <p className="mcard-name">{capitalize(name)} is vacant</p>
        <p className="mcard-top">No one holds this seat right now.</p>
        {note}
      </div>
    </article>
  );
}

function sharePhrase(share: number) {
  if (share >= 0.995) return "All";
  if (share > 0.95) return "Nearly all";
  return `About ${Math.max(1, Math.round(share * 100))}%`;
}
function listOf(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
