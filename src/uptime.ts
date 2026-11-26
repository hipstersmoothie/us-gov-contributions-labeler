// Watches the public services and DMs the owner on Bluesky when one goes down
// and when it's back: the `uptime` Railway service (src/uptime.Dockerfile).
//
//   pnpm uptime            run forever, checking every CHECK_MS
//   pnpm uptime --once     check once, print the results, alert nobody
//   pnpm uptime --test     send a test DM and exit
//
// A service is down after FAILS_TO_ALERT failed checks in a row, so a single
// slow response or a deploy's few seconds of 502s don't page anyone. State is
// in memory: a restart forgets an open outage and alerts it again, once.
//
// It logs in only to send, so the checks don't spend the labeler account's
// session budget (createSession allows ~300 a day, and other jobs log in too).
// The app password has to allow DMs (BSKY_DM_APP_PASSWORD, the posts service's).
import "dotenv/config";
import { AtpAgent } from "@atproto/api";

const IDENTIFIER = process.env.BSKY_IDENTIFIER ?? "did:plc:ylmdlijvrvgbe4md6v4dyce6";
const PASSWORD = process.env.BSKY_DM_APP_PASSWORD;
/** Who gets the DMs: hipstersmoothie.com. */
const ALERT_TO = process.env.ALERT_TO ?? "did:plc:m2sjv3wncvsasdapla35hzwj";
const CHECK_MS = Number(process.env.CHECK_SECONDS ?? 120) * 1000;
const FAILS_TO_ALERT = 2;
const TIMEOUT_MS = 20_000;
/** Feed posts arrive only when a member posts, but a whole quiet night is about the most there is. */
const MAX_FEED_LAG_S = 8 * 60 * 60;

interface Check {
  name: string;
  url: string;
  /** Why a 200 response is still wrong, if it is. */
  verify?: (body: string) => string | undefined;
}

const CHECKS: Check[] = [
  { name: "Website", url: "https://contributions.fyi/", verify: (b) => (b.includes("</html>") ? undefined : "the page came back incomplete") },
  { name: "Member pages", url: "https://contributions.fyi/members/" },
  {
    name: "Feeds",
    url: "https://feeds.contributions.fyi/health",
    verify: (b) => {
      const lag = (JSON.parse(b) as { jetstreamLagSeconds?: number }).jetstreamLagSeconds ?? Infinity;
      return lag > MAX_FEED_LAG_S ? `no new member posts in ${Math.round(lag / 3600)}h (Jetstream may be stuck)` : undefined;
    },
  },
  { name: "Labeler", url: "https://us-gov-contributions-labeler.up.railway.app/xrpc/com.atproto.label.queryLabels?uriPatterns=did:*&limit=1" },
  { name: "PDS", url: "https://pds.contributions.fyi/xrpc/_health" },
];

/** Why the check failed, or undefined if it passed. */
async function probe(check: Check): Promise<string | undefined> {
  try {
    const res = await fetch(check.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "contributions.fyi uptime" } });
    const body = await res.text();
    if (!res.ok) return `HTTP ${res.status}`;
    return check.verify?.(body);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === "TimeoutError") return `no response in ${TIMEOUT_MS / 1000}s`;
    return e.cause?.code ?? e.message;
  }
}

async function dm(text: string) {
  if (!PASSWORD) throw new Error("BSKY_DM_APP_PASSWORD isn't set");
  const agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: IDENTIFIER, password: PASSWORD });
  const chat = agent.withProxy("bsky_chat", "did:web:api.bsky.chat");
  const { data } = await chat.chat.bsky.convo.getConvoForMembers({ members: [ALERT_TO] });
  await chat.chat.bsky.convo.sendMessage({ convoId: data.convo.id, message: { text } });
}

const since = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

interface State {
  fails: number;
  downSince?: number;
  /** Whether the "down" DM went out; if not, the next check tries again. */
  alerted: boolean;
  lastError?: string;
}
const state = new Map<string, State>(CHECKS.map((c) => [c.name, { fails: 0, alerted: false }]));

async function tick() {
  const results = await Promise.all(CHECKS.map(async (c) => [c, await probe(c)] as const));
  const messages: string[] = [];
  const sent: (() => void)[] = [];
  for (const [check, error] of results) {
    const s = state.get(check.name)!;
    if (error) {
      s.fails++;
      s.downSince ??= Date.now();
      s.lastError = error;
      console.log(`${check.name}: failing (${s.fails}): ${error}`);
      if (s.fails >= FAILS_TO_ALERT && !s.alerted) {
        messages.push(`🔴 ${check.name} is down: ${error}\n${check.url}`);
        sent.push(() => (s.alerted = true));
      }
    } else {
      if (s.alerted) {
        messages.push(`✅ ${check.name} is back up after ${since(s.downSince!)}.`);
        sent.push(() => Object.assign(s, { alerted: false, downSince: undefined }));
      } else if (s.fails) {
        console.log(`${check.name}: recovered before alerting`);
        s.downSince = undefined;
      }
      s.fails = 0;
    }
  }
  if (!messages.length) return;
  try {
    await dm(messages.join("\n\n"));
    for (const done of sent) done();
    console.log(`Sent: ${messages.join(" | ")}`);
  } catch (err) {
    // Tried again on the next check.
    console.error("uptime: DM failed:", (err as Error).message);
  }
}

if (process.argv.includes("--test")) {
  await dm("Uptime monitor for contributions.fyi is on. You'll get a DM here when a service goes down, and when it's back.");
  console.log("Sent a test DM");
} else if (process.argv.includes("--once")) {
  for (const c of CHECKS) console.log(`${c.name}: ${(await probe(c)) ?? "ok"}`);
} else {
  console.log(`Checking ${CHECKS.length} services every ${CHECK_MS / 1000}s`);
  for (;;) {
    await tick().catch((err: unknown) => console.error("uptime: check failed:", err));
    await new Promise((r) => setTimeout(r, CHECK_MS));
  }
}
