// Label values have to match ^[a-z-]+$ on Bluesky.
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function labelValue(name: string) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/\d/g, (d) => ` ${DIGITS[Number(d)]} `)
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

export interface LiveLabel {
  src: string;
  uri: string;
  val: string;
  neg?: boolean;
  cts: string;
}

/** Every label currently in effect on the labeler, via its public endpoint. */
export async function fetchLiveLabels(serviceUrl: string, labelerDid: string) {
  const events: LiveLabel[] = [];
  let cursor = "0";
  for (;;) {
    const qs = new URLSearchParams({ uriPatterns: "*", limit: "250", cursor });
    const res = await fetch(`${serviceUrl}/xrpc/com.atproto.label.queryLabels?${qs}`);
    if (!res.ok) throw new Error(`queryLabels failed: ${res.status}`);
    const page = (await res.json()) as { labels: LiveLabel[]; cursor: string };
    events.push(...page.labels);
    if (page.labels.length < 250) break;
    cursor = page.cursor;
  }

  // Replay in order; a negation cancels the label before it.
  const active = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.src !== labelerDid) continue;
    const vals = active.get(e.uri) ?? new Set<string>();
    if (e.neg) vals.delete(e.val);
    else vals.add(e.val);
    active.set(e.uri, vals);
  }
  return { events: events.length, active };
}

/** The labeler's service URL, from its DID document. */
export async function labelerServiceUrl(did: string) {
  const res = await fetch(`https://plc.directory/${did}`);
  const doc = (await res.json()) as { service: { id: string; serviceEndpoint: string }[] };
  const service = doc.service.find((s) => s.id === "#atproto_labeler");
  if (!service) throw new Error(`${did} has no labeler service`);
  return service.serviceEndpoint;
}

export const PER_KIND = 3;
// Not industries, or not informative as a label.
const SKIP_SECTORS = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

export interface MemberLabel {
  kind: "sector" | "contributor";
  value: string;
  name: string;
  /** The sector name, or the contributor's organization id. */
  id: string;
}

/** The labels the labeler puts on a member's accounts: their top 3 sectors
 *  and top 3 contributors, counting an organization's PAC plus its employees. */
export function memberLabels(
  m: { combinedSectors: { id: string }[]; contributors: { id: string; name: string }[] },
  orgById: Map<string, { sector?: string }>
): MemberLabel[] {
  const sectors = m.combinedSectors
    .filter((s) => !SKIP_SECTORS.has(s.id))
    .slice(0, PER_KIND)
    .map((s) => ({ kind: "sector" as const, value: labelValue(s.id), name: s.id, id: s.id }));
  const contributors = m.contributors
    .filter((c) => orgById.get(c.id)?.sector !== "Party & Candidate Committees")
    .slice(0, PER_KIND)
    .map((c) => ({ kind: "contributor" as const, value: labelValue(c.name), name: c.name, id: c.id }));
  return [...sectors, ...contributors].filter((l) => l.value);
}
