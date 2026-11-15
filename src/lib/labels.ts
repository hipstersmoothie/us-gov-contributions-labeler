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
